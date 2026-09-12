#!/bin/sh
# Materialize Railway-injected private source env vars into *_FILE paths, then
# unset inline sources so production-config fail-closed dual-source checks pass.
set -eu

SECRETS_DIR="${MINO_SECRETS_DIR:-/tmp/mino-secrets}"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

materialize() {
  # materialize <file_basename> <source_env> <file_env>
  _file="$1"
  _src="$2"
  _file_env="$3"
  eval "_val=\${$_src-}"
  if [ -n "${_val}" ]; then
    printf '%s' "$_val" > "$SECRETS_DIR/$_file"
    chmod 600 "$SECRETS_DIR/$_file"
    unset "$_src"
    export "$_file_env=$SECRETS_DIR/$_file"
  fi
}

materialize database_url DATABASE_URL DATABASE_URL_FILE
materialize redis_url REDIS_URL REDIS_URL_FILE

materialize mandate_private_key.pem MINO_MANDATE_PRIVATE_KEY MINO_MANDATE_PRIVATE_KEY_FILE
materialize delegation_private_key.pem MINO_DELEGATION_PRIVATE_KEY MINO_DELEGATION_PRIVATE_KEY_FILE
materialize audit_private_key.pem MINO_AUDIT_PRIVATE_KEY MINO_AUDIT_PRIVATE_KEY_FILE
materialize approval_resolution_secret MINO_APPROVAL_RESOLUTION_SECRET MINO_APPROVAL_RESOLUTION_SECRET_FILE
materialize approval_webhook_secret MINO_APPROVAL_WEBHOOK_SECRET MINO_APPROVAL_WEBHOOK_SECRET_FILE
materialize merchant_credentials.json MINO_MERCHANT_CREDENTIALS MINO_MERCHANT_CREDENTIALS_FILE
materialize audit_checkpoint_retention_secret MINO_AUDIT_CHECKPOINT_RETENTION_SECRET MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE
materialize metrics_bearer_token MINO_METRICS_BEARER_TOKEN MINO_METRICS_BEARER_TOKEN_FILE

if [ -z "${MINO_PORT-}" ] && [ -n "${PORT-}" ]; then
  export MINO_PORT="$PORT"
fi

exec "$@"
