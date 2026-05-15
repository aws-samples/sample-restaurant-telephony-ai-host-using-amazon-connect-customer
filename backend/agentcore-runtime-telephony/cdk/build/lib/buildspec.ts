/**
 * CodeBuild buildspec for the telephony agent image.
 *
 * Implements task 4.3:
 * - install Python deps from `requirements.txt`
 * - reproducibility gate (NFR3 / P8): `pip freeze` and `diff -q` against the
 *   committed `requirements.lock`. Non-empty diff fails the build.
 * - docker buildx against ARM64, push to ECR (`$IMAGE_REPO_URI:latest`).
 *
 * Env vars the project injects (set in build-stack.ts):
 *   - IMAGE_REPO_URI   — from CfnParameter AgentEcrRepoUri
 *   - AWS_REGION       — fixed us-east-1
 *   - AWS_ACCOUNT_ID   — resolved via Aws.ACCOUNT_ID
 *
 * All commands run inside CodeBuild's ARM64 standard:5.0 image. No Python on
 * the developer workstation is ever invoked (P7 / NFR4).
 */
export const buildspec = {
  version: '0.2',
  env: {
    variables: {
      DOCKER_BUILDKIT: '1',
    },
  },
  phases: {
    pre_build: {
      commands: [
        'echo "=== pre_build: sanity checks ==="',
        'node --version',
        'aws --version',
        'docker --version',
        'echo "IMAGE_REPO_URI=${IMAGE_REPO_URI}"',
        'echo "=== pre_build: source layout ==="',
        'pwd && ls -la',
        'echo "=== pre_build: ECR login ==="',
        'aws ecr get-login-password --region "${AWS_REGION}" | docker login --username AWS --password-stdin "${IMAGE_REPO_URI%%/*}"',
        'echo "=== pre_build: install agent runtime deps for lock-gate (NFR3 / P8) ==="',
        // BucketDeployment unpacks the `agent/` tree contents at the CodeBuild
        // source root, so requirements.txt + Dockerfile live right here — no
        // `cd agent` needed.
        'python3 -m pip install --upgrade pip',
        'python3 -m pip install -r requirements.txt',
        'echo "=== pre_build: reproducibility gate ==="',
        'python3 -m pip freeze | sort > /tmp/installed.lock',
        // First-build path: if requirements.lock is empty OR has only comment
        // lines (the scaffold placeholder), copy the freeze output so the
        // build succeeds and the operator can commit the generated file.
        // Subsequent builds diff against the committed file and fail on drift.
        'LOCK_PAYLOAD=$(grep -vE "^\\s*(#|$)" requirements.lock || true); if [ -z "$LOCK_PAYLOAD" ]; then echo "requirements.lock has no pinned packages (first build or placeholder) — writing freeze output so the operator can commit it"; cp /tmp/installed.lock requirements.lock; echo "=== generated requirements.lock (commit this) ==="; cat requirements.lock; else echo "=== diff requirements.lock ==="; diff -q <(sort requirements.lock) /tmp/installed.lock || { echo "FAIL: requirements.lock drift detected (NFR3 / P8). Commit the updated lock from the log above, or re-run with the generator mode."; exit 1; }; fi',
      ],
    },
    build: {
      commands: [
        'echo "=== build: docker buildx arm64 ==="',
        'docker buildx build --platform=linux/arm64 -t "${IMAGE_REPO_URI}:latest" --load .',
      ],
    },
    post_build: {
      commands: [
        'echo "=== post_build: docker push ==="',
        'docker push "${IMAGE_REPO_URI}:latest"',
        'echo "=== post_build: done ==="',
      ],
    },
  },
};
