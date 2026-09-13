function firstNonBlank(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

const runtimeStartedAt = new Date().toISOString();

export function deploymentMetadata(
  env: NodeJS.ProcessEnv,
  deployedAt = runtimeStartedAt,
) {
  const railwayDeployment = firstNonBlank(env.RAILWAY_DEPLOYMENT_ID);
  return {
    version: firstNonBlank(env.APP_VERSION) ?? "0.1.0",
    commitSha: (
      firstNonBlank(env.RAILWAY_GIT_COMMIT_SHA, env.GIT_COMMIT_SHA) ??
      "development"
    ).slice(0, 40),
    buildTime: railwayDeployment
      ? deployedAt
      : (firstNonBlank(env.BUILD_TIME) ?? "development"),
    deploymentId: railwayDeployment ?? "development",
    sourceBranch: firstNonBlank(env.RAILWAY_GIT_BRANCH) ?? "development",
  };
}
