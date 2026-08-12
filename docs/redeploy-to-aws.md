You do not copy the source files directly into ECS. Rebuild the Studio Docker image locally, push it to Amazon ECR, and force ECS to replace the running container.

Run these commands from the Studio repository directory containing the deployed `Dockerfile`.

### 1. Sign in to AWS

```bash
aws sso login --profile ao-cc-studio-portal
```

Confirm the account:

```bash
aws sts get-caller-identity \
  --profile ao-cc-studio-portal
```

### 2. Confirm the image currently used by ECS

```bash
CC_TASK_DEFINITION=$(aws ecs describe-services \
  --cluster default \
  --services ao-cc-studio \
  --region us-east-1 \
  --profile ao-cc-studio-portal \
  --qquery 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' \
  --output text)

aws ecs describe-task-definition \
  --task-definition "$CC_TASK_DEFINITION" \
  --region us-east-1 \
  --profile ao-cc-studio-portal \
  --query 'taskDefinition.containerDefinitions[].{Container:name,Image:image}' \
  --output table
```

The image will probably be similar to:

```text
945824236547.dkr.ecr.us-east-1.amazonaws.com/ao-cc-studio:latest
```

### 3. Authenticate Docker with ECR

```bash
aws ecr get-login-password \
  --region us-east-1 \
  --profile ao-cc-studio-portal |
docker login \
  --username AWS \
  --password-stdin \
  945824236547.dkr.ecr.us-east-1.amazonaws.com
```

AWS documents this as the standard ECR authentication process. [AWS ECR documentation](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)

### 4. Build and push the updated image

From the Studio project root:

```bash
CC_IMAGE="945824236547.dkr.ecr.us-east-1.amazonaws.com/ao-cc-studio:latest"

docker buildx build \
  --platform linux/amd64 \
  --tag "$CC_IMAGE" \
  --push \
  .
```

Use `linux/amd64` because you are building on a Mac and the existing ECS task is most likely x86-64. If the task definition says `ARM64`, change it to `linux/arm64`. Docker supports selecting the target architecture through `--platform`. [Docker multi-platform documentation](https://docs.docker.com/build/building/multi-platform/)

If the AWS deployment uses a special Dockerfile, add it:

```bash
docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.aws \
  --tag "$CC_IMAGE" \
  --push \
  .
```

### 5. Force ECS to deploy the new image

Because you reused the `latest` tag, the task definition does not need to change:

```bash
aws ecs update-service \
  --cluster default \
  --service ao-cc-studio \
  --force-new-deployment \
  --region us-east-1 \
  --profile ao-cc-studio-portal
```

AWS confirms that `--force-new-deployment` starts new tasks using the current image associated with the same tag. [AWS ECS CLI documentation](https://docs.aws.amazon.com/cli/latest/reference/ecs/update-service.html)

### 6. Check the deployment

```bash
aws ecs describe-services \
  --cluster default \
  --services ao-cc-studio \
  --region us-east-1 \
  --profile ao-cc-studio-portal \
  --query 'services[0].{Desired:desiredCount,Running:runningCount,Pending:pendingCount,TaskDefinition:taskDefinition}' \
  --output table
```

Then inspect recent deployment events:

```bash
aws ecs describe-services \
  --cluster default \
  --services ao-cc-studio \
  --region us-east-1 \
  --profile ao-cc-studio-portal \
  --query 'services[0].events[0:10].[createdAt,message]' \
  --output table
```

One important detail from your previous deployment: if `Desired` is `0`, ECS will not start the updated container. Set it back to `1`:

```bash
aws ecs update-service \
  --cluster default \
  --service ao-cc-studio \
  --desired-count 1 \
  --force-new-deployment \
  --region us-east-1 \
  --profile ao-cc-studio-portal
```

Once `Running` is `1`, `Pending` is `0`, and the deployment is completed, refresh the Studio URL—preferably with a hard browser refresh to clear cached frontend files.
