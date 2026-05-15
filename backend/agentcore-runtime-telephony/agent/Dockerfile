FROM --platform=linux/arm64 public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

RUN pip install --upgrade pip

# System deps. The agent has no native media libraries — the Node
# SIP-gateway bridge handles all codec conversion (μ-law 8 kHz ↔ L16
# 16 kHz) on its side. What we keep:
#   gcc/g++/make — native extension fallbacks for any transitive pip deps
#   git          — mcp-proxy-for-aws installs from a git tag
#   curl         — used by the Docker HEALTHCHECK below
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first so the layer caches across source edits.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Copy application source.
COPY telephony_agent.py protocol.py session.py pstn_customer.py mcp_tools.py system_prompt.py prompt_renderer.py ./

# Smoke test — fail the build early if imports are broken.
RUN python -c "import telephony_agent"

# Non-root user per AgentCore Runtime best practice.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8080/ping || exit 1

ENTRYPOINT ["python", "-m", "uvicorn", "telephony_agent:app", "--host", "0.0.0.0", "--port", "8080"]
