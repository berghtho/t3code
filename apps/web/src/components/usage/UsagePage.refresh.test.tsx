import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";

type RefreshResult = AtomCommandResult<void, string>;
type RefreshInput = {
  readonly environmentId: EnvironmentId;
  readonly input: Record<string, never>;
};
interface PresentationFixture {
  readonly entry: { readonly target: { readonly label: string } };
  readonly connection: { readonly phase: "connected" | "disconnected" };
  readonly serverConfig: Record<string, never> | null;
}

const testState = vi.hoisted(() => ({
  presentations: new Map<EnvironmentId, PresentationFixture>(),
  environments: [] as EnvironmentUsageStatus[],
  useUsage: vi.fn(),
  refreshProviders: vi.fn<(input: RefreshInput) => Promise<RefreshResult>>(),
  refreshUsage: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.presentations }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: Symbol("presentations") },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => testState.refreshProviders,
}));
vi.mock("../../state/usage", () => ({ useUsage: testState.useUsage }));
vi.mock("../ui/toast", () => ({ toastManager: { add: testState.toast } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/menu", () => ({
  Menu: "menu-root",
  MenuTrigger: "menu-trigger",
  MenuPopup: "menu-popup",
  MenuCheckboxItem: "label",
  MenuItem: "menu-item",
  MenuSeparator: "menu-separator",
}));
vi.mock("../ui/select", () => ({
  Select: "select-root",
  SelectItem: "select-item",
  SelectPopup: "select-popup",
  SelectTrigger: "select-trigger",
  SelectValue: "select-value",
}));
vi.mock("../ui/toggle-group", () => ({ Toggle: "toggle", ToggleGroup: "toggle-group" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/skeleton", () => ({ Skeleton: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageLimits", () => ({ UsageLimitsSection: "usage-limits" }));
vi.mock("./UsageProviderChart", () => ({ UsageProviderChart: "usage-chart" }));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", () => ({
  PROVIDER_ORDER: [],
  PROVIDER_PRESENTATION: {},
  providersWithUsage: () => [],
}));

import { UsagePage } from "./UsagePage";

let renderer: ReactTestRenderer | null = null;

function seed(...entries: readonly { id: string; connected?: boolean; config?: boolean }[]) {
  testState.presentations = new Map(
    entries.map(({ id, connected = true, config = true }) => [
      EnvironmentId.make(id),
      {
        entry: { target: { label: id } },
        connection: { phase: connected ? "connected" : "disconnected" },
        serverConfig: config ? {} : null,
      },
    ]),
  );
  testState.environments = entries.map(({ id }) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    summary: null,
    isPending: true,
    error: null,
  }));
}

async function mountLimits() {
  await act(() => {
    renderer = create(<UsagePage />);
  });
  const metric = renderer!.root.findByProps({
    "aria-label": "Usage metric",
    variant: "segmented",
  });
  await act(() => metric.props.onValueChange(["limits"]));
}

async function deselect(label: string) {
  const item = renderer!.root
    .findAllByType("label")
    .find(
      (candidate) =>
        candidate.findAll((child) => child.type === "span" && child.children.includes(label))
          .length > 0,
    );
  if (!item) throw new Error(`Missing environment checkbox: ${label}`);
  await act(() => item.props.onCheckedChange(false));
}

async function refreshLimits() {
  const button = renderer!.root.findAllByProps({ "aria-label": "Refresh limits" })[0];
  if (!button) throw new Error("Missing limits refresh button");
  await act(async () => button.props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.refreshProviders.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  testState.refreshUsage.mockReset();
  testState.toast.mockReset();
  testState.useUsage
    .mockReset()
    .mockImplementation(
      (_input: UsageSummaryInput, selected: ReadonlySet<EnvironmentId> | null) => ({
        merged: mergeUsage([], USAGE_CONTRACT_VERSION),
        environments: testState.environments,
        selectedEnvironments:
          selected === null
            ? testState.environments
            : testState.environments.filter((entry) => selected.has(entry.environmentId)),
        isPending: true,
        isPartial: true,
        refresh: testState.refreshUsage,
      }),
    );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("limits refresh across selected environments", () => {
  it("refreshes selected connected hosts with config and skips the others", async () => {
    seed(
      { id: "alpha" },
      { id: "beta" },
      { id: "offline", connected: false },
      { id: "no-config", config: false },
      { id: "excluded" },
    );
    await mountLimits();
    await deselect("excluded");
    await refreshLimits();

    expect(testState.refreshProviders.mock.calls.map(([input]) => input)).toEqual([
      { environmentId: "alpha", input: {} },
      { environmentId: "beta", input: {} },
    ]);
    expect(testState.refreshUsage).not.toHaveBeenCalled();
    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("starts every host while another is pending and reports only the failing host", async () => {
    seed({ id: "slow" }, { id: "failed" }, { id: "healthy" });
    let finishSlow: (result: RefreshResult) => void = () => {
      throw new Error("Slow refresh was not started");
    };
    const slow = new Promise<RefreshResult>((resolve) => {
      finishSlow = resolve;
    });
    testState.refreshProviders.mockImplementation(({ environmentId }) =>
      environmentId === "slow"
        ? slow
        : Promise.resolve(
            environmentId === "failed"
              ? AsyncResult.failure(Cause.fail("host unavailable"))
              : AsyncResult.success(undefined),
          ),
    );
    await mountLimits();
    await refreshLimits();

    expect(testState.refreshProviders.mock.calls.map(([input]) => input.environmentId)).toEqual([
      "slow",
      "failed",
      "healthy",
    ]);
    expect(testState.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not refresh limits for failed",
    });

    await act(async () => finishSlow(AsyncResult.success(undefined)));
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted refreshes silent while another host succeeds", async () => {
    seed({ id: "interrupted" }, { id: "healthy" });
    testState.refreshProviders.mockImplementation(({ environmentId }) =>
      Promise.resolve(
        environmentId === "interrupted"
          ? AsyncResult.failure(Cause.interrupt())
          : AsyncResult.success(undefined),
      ),
    );
    await mountLimits();
    await refreshLimits();

    expect(testState.refreshProviders).toHaveBeenCalledTimes(2);
    expect(testState.toast).not.toHaveBeenCalled();
  });
});
