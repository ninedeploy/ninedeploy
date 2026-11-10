mkdir -p "$RUNNER_TEMP/ninedeploy-server-full-unit-audit"
printf 'AUDIT_LOG_DIR=%s\n' "$RUNNER_TEMP/ninedeploy-server-full-unit-audit" >> "$GITHUB_ENV"
printf 'ref=%s\nsha=%s\n' "$GITHUB_REF" "$GITHUB_SHA" > "$RUNNER_TEMP/ninedeploy-server-full-unit-audit/bootstrap.txt"
uname -sm >> "$RUNNER_TEMP/ninedeploy-server-full-unit-audit/bootstrap.txt"
