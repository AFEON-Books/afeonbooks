declare const __DEPLOYMENT_VERSION__: string;

const CHECK_INTERVAL_MS = 60_000;
const RELOADED_VERSION_KEY = "afeonbooks_reloaded_deployment_version";

export function startDeploymentReloadMonitor(): void {
  if (!import.meta.env.PROD) return;

  let checking = false;

  const checkForDeployment = async () => {
    if (document.visibilityState !== "visible" || checking) return;
    checking = true;

    try {
      const versionUrl = new URL(
        `${import.meta.env.BASE_URL}deployment-version.json`,
        window.location.origin,
      );
      versionUrl.searchParams.set("check", Date.now().toString());
      const response = await fetch(versionUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Deployment version check failed (${response.status})`);
      }

      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("version" in payload) ||
        typeof payload.version !== "string"
      ) {
        throw new Error("Deployment version response is invalid");
      }

      if (payload.version !== __DEPLOYMENT_VERSION__) {
        if (sessionStorage.getItem(RELOADED_VERSION_KEY) === payload.version) return;
        sessionStorage.setItem(RELOADED_VERSION_KEY, payload.version);
        window.location.reload();
        return;
      }

      sessionStorage.removeItem(RELOADED_VERSION_KEY);
    } catch (error) {
      console.warn("Unable to check for a new deployment", error);
    } finally {
      checking = false;
    }
  };

  window.setInterval(() => void checkForDeployment(), CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForDeployment();
  });
  void checkForDeployment();
}
