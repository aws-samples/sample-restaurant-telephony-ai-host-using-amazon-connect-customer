/**
 * CodeBuild buildspec for the SIP gateway image.
 *
 * This file is imported by
 * `telephony-interface/telephony-sip-gateway/cdk/lib/sip-gateway-stack.ts`
 * via `codebuild.BuildSpec.fromObject(...)`.  Keeping it as a TypeScript
 * export (rather than a committed YAML file) lets the stack reference
 * `process.env`-injected values directly as `$IMAGE_REPO_URI` etc.
 *
 * Build flow:
 *   1. Log into ECR using the CodeBuild role's temp creds.
 *   2. `docker buildx` the SIP gateway image for `linux/arm64` using the
 *      unpacked source tree (CodeBuild stages the zip into $CODEBUILD_SRC_DIR).
 *   3. Tag + push as both `:latest` and `:${CODEBUILD_BUILD_NUMBER}` so
 *      operators can roll back via the numbered tag.
 *
 * The CodeBuild project environment has `privileged=true` so the
 * Docker-in-Docker buildx driver can run.
 */
export const buildspec = {
  version: '0.2',
  phases: {
    pre_build: {
      commands: [
        'echo "=== pre_build ==="',
        'echo "CODEBUILD_SRC_DIR=$CODEBUILD_SRC_DIR"',
        'ls -la "$CODEBUILD_SRC_DIR"',
        'aws --version',
        'docker --version',
        'echo "=== ECR login ==="',
        'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$(echo "$IMAGE_REPO_URI" | cut -d/ -f1)"',
      ],
    },
    build: {
      commands: [
        'echo "=== build ==="',
        'cd "$CODEBUILD_SRC_DIR"',
        'docker buildx create --use --name sipgwbuilder || true',
        'IMAGE_TAG="${CODEBUILD_BUILD_NUMBER}-$(date +%Y%m%d-%H%M%S)"',
        'echo "IMAGE_TAG=$IMAGE_TAG"',
        'docker buildx build --platform linux/arm64 --load -t "local/sip-gateway:build" .',
        'docker tag local/sip-gateway:build "$IMAGE_REPO_URI:latest"',
        'docker tag local/sip-gateway:build "$IMAGE_REPO_URI:$IMAGE_TAG"',
      ],
    },
    post_build: {
      commands: [
        'echo "=== post_build ==="',
        'docker push "$IMAGE_REPO_URI:latest"',
        'docker push "$IMAGE_REPO_URI:$IMAGE_TAG"',
        'echo "IMAGE pushed: $IMAGE_REPO_URI:latest  AND  $IMAGE_REPO_URI:$IMAGE_TAG"',
      ],
    },
  },
};
