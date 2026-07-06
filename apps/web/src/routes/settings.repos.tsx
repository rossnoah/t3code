import { createFileRoute } from "@tanstack/react-router";

import { ReposSettingsPanel } from "../components/settings/ReposSettings";

export const Route = createFileRoute("/settings/repos")({
  component: ReposSettingsPanel,
});
