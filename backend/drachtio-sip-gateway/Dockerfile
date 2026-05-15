# syntax=docker/dockerfile:1
# drachtio-server + rtpengine + Node.js telephony gateway.
#
# Replaces an earlier prototype that used FreeSWITCH plus mod_audio_stream.
# Same goal — accept inbound SIP/TCP 5060 from the Chime Voice Connector
# (VC), bridge caller RTP to a SigV4-signed WebSocket at Bedrock AgentCore
# Runtime (ACR) — but using a cleaner stack:
#   1. drachtio-server  (github.com/drachtio/drachtio-server) — Sofia-SIP
#      based SIP proxy that exposes an admin control socket so Node.js can
#      accept/reject calls and send SIP responses.
#   2. rtpengine        (github.com/sipwise/rtpengine) — C media proxy that
#      bridges RTP between two endpoints. We configure one endpoint as the
#      caller (via the NLB) and the other endpoint as a loopback UDP socket
#      our Node.js app owns.
#   3. Node.js 22 LTS app — receives INVITE events from drachtio, orchestrates
#      rtpengine, opens the AgentCore WebSocket, and shuttles audio between
#      the loopback RTP socket and the WebSocket.
#
# Base image is Amazon's ECR Public mirror of debian:bookworm-slim
# (public.ecr.aws/docker/library/debian:bookworm-slim) — pulled from AWS
# infrastructure with no rate limit and no credentials.
#
# Pinned versions (locked for reproducibility):
#   drachtio-server  main branch  (upstream release-cadence is lightweight;
#                                  docker.drachtio.org uses the same convention)
#   rtpengine        mr13.5.1.10  (conservative LTS branch; tip mr26.x works
#                                  too but we pick the most battle-tested)
#   Node.js          22.x LTS     via deb.nodesource.com
#
# ---------------------------------------------------------------------------
# Stage 1: compile drachtio-server and rtpengine from source.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/debian:bookworm-slim AS build

ARG DRACHTIO_REF=main
ARG RTPENGINE_TAG=mr13.5.1.10

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Build toolchain + -dev headers. Grouped by consumer:
#   toolchain:          build-essential, cmake, autoconf, automake, libtool,
#                       libtool-bin, pkg-config, git, ca-certificates, curl
#   drachtio-server:    libssl-dev, libcurl4-openssl-dev, zlib1g-dev,
#                       libgoogle-perftools-dev (tcmalloc), libboost-all-dev
#   rtpengine:          libglib2.0-dev, libjson-glib-dev, libpcre2-dev,
#                       libhiredis-dev, gperf, libevent-dev, libpcap-dev,
#                       libsystemd-dev, libspandsp-dev, libmosquitto-dev,
#                       libwebsockets-dev, libopus-dev, libiptc-dev,
#                       libmnl-dev, libnftnl-dev, libnftables-dev,
#                       libavcodec-dev, libavfilter-dev, libavformat-dev,
#                       libavutil-dev, libswresample-dev, libncurses-dev,
#                       libjwt-dev, default-libmysqlclient-dev (for libmariadb),
#                       pandoc (manpage generator)
#
# NOTE: even with `with_transcoding=no`, rtpengine's common pkg-config
# flag generator probes every dep unconditionally (utils/gen-common-flags
# exits non-zero on the first missing one). So the -dev packages for
# libavcodec, libavfilter, etc. must be present at build time even if
# the resulting binary never loads them. Stage-2 runtime does NOT need
# these, keeping the final image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      autoconf \
      automake \
      libtool \
      libtool-bin \
      pkg-config \
      git \
      ca-certificates \
      curl \
      jq \
      libssl-dev \
      libcurl4-openssl-dev \
      zlib1g-dev \
      libgoogle-perftools-dev \
      libboost-all-dev \
      libglib2.0-dev \
      libjson-glib-dev \
      libpcre2-dev \
      libhiredis-dev \
      gperf \
      libevent-dev \
      libpcap-dev \
      libsystemd-dev \
      libspandsp-dev \
      libmosquitto-dev \
      libwebsockets-dev \
      libopus-dev \
      libiptc-dev \
      libmnl-dev \
      libnftnl-dev \
      libnftables-dev \
      libavcodec-dev \
      libavfilter-dev \
      libavformat-dev \
      libavutil-dev \
      libswresample-dev \
      libncurses-dev \
      libjwt-dev \
      default-libmysqlclient-dev \
      pandoc \
  && rm -rf /var/lib/apt/lists/*

# ----- drachtio-server -----
WORKDIR /src
RUN git clone --depth=50 https://github.com/drachtio/drachtio-server.git drachtio
WORKDIR /src/drachtio
RUN git fetch --tags \
 && git checkout "$DRACHTIO_REF" \
 && git submodule update --init --recursive \
 && ./bootstrap.sh \
 && mkdir build \
 && cd build \
 && ../configure --enable-tcmalloc=yes CPPFLAGS='-DNDEBUG' CXXFLAGS='-O2' \
 && make -j"$(nproc)" \
 && make install

# ----- rtpengine (daemon only; no DKMS kernel module on Fargate) -----
WORKDIR /src
RUN git clone --branch "$RTPENGINE_TAG" --depth=1 https://github.com/sipwise/rtpengine.git
WORKDIR /src/rtpengine/daemon
# with_transcoding=no: G.711 PCMU/PCMA passthrough is all we need; skipping
# ffmpeg-based transcoding saves ~180 MB of runtime libs.
RUN make -j"$(nproc)" with_transcoding=no \
 && mkdir -p /out \
 && install -m755 rtpengine /out/rtpengine

# Discovery step: print the full set of runtime library paths both
# binaries depend on, plus the Debian packages that own them. The log
# from this RUN is the authoritative list of apt packages the stage-2
# runtime image needs. Check here first when a "cannot open shared
# object file" error appears at container start.
RUN echo "=== drachtio runtime deps ===" \
 && ldd /usr/local/bin/drachtio | awk '/=>/{print $3}' | sort -u \
 && echo "=== rtpengine runtime deps ===" \
 && ldd /out/rtpengine | awk '/=>/{print $3}' | sort -u \
 && echo "=== drachtio runtime packages ===" \
 && ldd /usr/local/bin/drachtio | awk '/=>/{print $3}' \
      | xargs -I{} dpkg -S {} 2>/dev/null | awk -F: '{print $1}' | sort -u \
 && echo "=== rtpengine runtime packages ===" \
 && ldd /out/rtpengine | awk '/=>/{print $3}' \
      | xargs -I{} dpkg -S {} 2>/dev/null | awk -F: '{print $1}' | sort -u

# ---------------------------------------------------------------------------
# Stage 2: runtime image.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    NODE_ENV=production

# Runtime apt deps. Derived directly from the ldd output of the compiled
# drachtio and rtpengine binaries (see the "=== drachtio runtime deps ==="
# / "=== rtpengine runtime deps ===" blocks in the build log — the
# discovery RUN is kept in stage 1 as a self-documenting sanity check).
#
# drachtio .so set:
#   libboost_filesystem, libboost_log, libboost_thread (1.74.0), libssl3,
#   libcurl4, libstdc++6, libtcmalloc (via libgoogle-perftools4), and the
#   transitive closure below (libnghttp2, libssh2, librtmp, libldap,
#   libgssapi-krb5, libgnutls, libnettle, libidn2, libpsl, libcom-err, etc.)
#
# rtpengine .so set:
#   libglib2.0-0, libjson-glib-1.0-0, libpcre2-8-0, libhiredis0.14,
#   libevent + libevent-core + libevent-pthreads, libpcap0.8, libsystemd0,
#   libspandsp2, libmosquitto1, libwebsockets17, libopus0, libiptc0,
#   libip4tc2, libip6tc2, libmnl0, libnftnl11, libdbus-1-3, libgcrypt20,
#   libmount1, libselinux1, libcap2, liblzma5, liblz4-1, and transitives.
#
# Ops + entrypoint: ca-certificates, curl, jq, tini, bash.
# Node.js is added via the NodeSource setup_22.x script below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      tini \
      bash \
      dnsutils \
      unzip \
      iproute2 \
      net-tools \
      procps \
      tcpdump \
      libc6 \
      libgcc-s1 \
      libstdc++6 \
      zlib1g \
      libzstd1 \
      libssl3 \
      libcurl4 \
      libnghttp2-14 \
      libssh2-1 \
      librtmp1 \
      libidn2-0 \
      libpsl5 \
      libsasl2-2 \
      libldap-2.5-0 \
      libgnutls30 \
      libnettle8 \
      libhogweed6 \
      libgmp10 \
      libp11-kit0 \
      libtasn1-6 \
      libunistring2 \
      libgssapi-krb5-2 \
      libkrb5-3 \
      libk5crypto3 \
      libkrb5support0 \
      libkeyutils1 \
      libcom-err2 \
      libbrotli1 \
      libffi8 \
      libboost-filesystem1.74.0 \
      libboost-log1.74.0 \
      libboost-thread1.74.0 \
      libboost-system1.74.0 \
      libboost-regex1.74.0 \
      libgoogle-perftools4 \
      libglib2.0-0 \
      libjson-glib-1.0-0 \
      libpcre2-8-0 \
      libhiredis0.14 \
      libevent-2.1-7 \
      libevent-core-2.1-7 \
      libevent-pthreads-2.1-7 \
      libpcap0.8 \
      libsystemd0 \
      libspandsp2 \
      libmosquitto1 \
      libwebsockets17 \
      libopus0 \
      libiptc0 \
      libip4tc2 \
      libip6tc2 \
      libmnl0 \
      libnftnl11 \
      libdbus-1-3 \
      libgcrypt20 \
      libgpg-error0 \
      libmount1 \
      libblkid1 \
      libselinux1 \
      libcap2 \
      liblzma5 \
      liblz4-1 \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 — entrypoint uses it to resolve the Network Load Balancer
# (NLB) public Elastic IP for the task's Availability Zone (AZ) via
# ec2:DescribeNetworkInterfaces. The task role already grants that
# action as part of the RTP target-registrar's discovery policy.
RUN ARCH=$(dpkg --print-architecture) \
 && if [ "$ARCH" = "arm64" ]; then AWS_ARCH=aarch64; else AWS_ARCH=x86_64; fi \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli \
 && rm -rf /tmp/aws /tmp/awscliv2.zip

# Copy the two compiled binaries from stage 1.
COPY --from=build /usr/local/bin/drachtio /usr/local/bin/drachtio
COPY --from=build /out/rtpengine          /usr/local/bin/rtpengine

# Install Node.js dependencies first so the layer caches across source edits.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source + configs + entrypoint.
COPY src/                 /app/src/
COPY drachtio.conf.xml    /etc/drachtio.conf.xml
COPY rtpengine.conf       /etc/rtpengine/rtpengine.conf
COPY entrypoint.sh        /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5060/tcp
EXPOSE 16000-16048/udp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
