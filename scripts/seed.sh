#!/usr/bin/env bash
# One-time seeding after the first `cdk deploy` (safe to re-run: never overwrites).
#  - active-profile pointer -> "survival"
#  - the survival profile.env -> S3 (only if absent; S3 is the config master afterwards)
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${REGION:-us-west-2}
BUCKET=$(aws --region "$REGION" cloudformation describe-stacks --stack-name HamaroGame \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)

if ! aws --region "$REGION" ssm get-parameter --name /hamaro/active-profile >/dev/null 2>&1; then
  aws --region "$REGION" ssm put-parameter --name /hamaro/active-profile --type String --value survival
  echo "seeded /hamaro/active-profile = survival"
fi

if aws --region "$REGION" s3api put-object --bucket "$BUCKET" \
    --key profiles/survival/profile.env --body server/profiles/survival.env \
    --if-none-match '*' >/dev/null 2>&1; then
  echo "seeded profiles/survival/profile.env"
else
  echo "profiles/survival/profile.env already exists — left untouched"
fi
