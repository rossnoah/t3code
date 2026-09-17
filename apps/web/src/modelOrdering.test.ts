import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  providerModelKey,
  reorderFavoriteModels,
  replaceProviderFavoriteModels,
  sortModelsForProviderInstance,
  sortProviderModelItems,
} from "./modelOrdering";

const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");

describe("model ordering", () => {
  it("groups favorites first while preserving provider model order inside each group", () => {
    const models = [
      { slug: "gpt-5.5" },
      { slug: "gpt-5.4-mini" },
      { slug: "crest-alpha" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["gpt-5.5", "gpt-5.4-mini", "crest-alpha"],
        groupFavorites: true,
        modelOrder: ["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"],
      }).map((model) => model.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "gpt-5.3-codex"]);
  });

  it("sorts the favorites view by provider order, then provider model order", () => {
    const items = [
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.4-mini" },
      { instanceId: CODEX_WORK_ID, slug: "gpt-5.5" },
      { instanceId: CODEX_WORK_ID, slug: "crest-alpha" },
      { instanceId: CLAUDE_ID, slug: "claude-opus-4-6" },
    ];
    const favoriteKeys = [
      providerModelKey(CODEX_WORK_ID, "gpt-5.5"),
      providerModelKey(CLAUDE_ID, "claude-opus-4-6"),
      providerModelKey(CODEX_WORK_ID, "gpt-5.4-mini"),
      providerModelKey(CODEX_WORK_ID, "crest-alpha"),
    ];

    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favoriteKeys,
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }).map((item) => item.slug),
    ).toEqual(["gpt-5.4-mini", "gpt-5.5", "crest-alpha", "claude-opus-4-6"]);
  });
});

describe("favorite model ordering", () => {
  const first = { provider: CODEX_WORK_ID, model: "shared-model" };
  const hidden = { provider: CODEX_WORK_ID, model: "hidden-model" };
  const second = { provider: CLAUDE_ID, model: "shared-model" };
  const last = { provider: CODEX_WORK_ID, model: "last-model" };
  const key = (favorite: typeof first) => providerModelKey(favorite.provider, favorite.model);

  it("uses the saved favorites order across instances, ahead of provider order", () => {
    const favorites = [second, last, first];
    const items = [first, last, second].map((f) => ({ instanceId: f.provider, slug: f.model }));
    expect(
      sortProviderModelItems(items, {
        favoriteModelKeys: favorites.map(key),
        favoriteModelOrder: favorites.map(key),
        instanceOrder: [CODEX_WORK_ID, CLAUDE_ID],
      }),
    ).toEqual([items[2], items[1], items[0]]);
  });

  it("reorders visible favorites without dropping or moving hidden favorites", () => {
    const favorites = [first, hidden, second, last];
    const reordered = reorderFavoriteModels(favorites, key(first), key(second));
    expect(reordered).toEqual([second, hidden, first, last]);
    expect(favorites).toEqual([first, hidden, second, last]);
    expect(reorderFavoriteModels(reordered, key(first), key(second))).toEqual(favorites);
    expect(reorderFavoriteModels(favorites, key(first), "missing")).toBe(favorites);
  });

  it("preserves other instances' slots when Settings reorders one instance", () => {
    expect(
      replaceProviderFavoriteModels([first, second, last], CODEX_WORK_ID, [
        last.model,
        first.model,
      ]),
    ).toEqual([last, second, first]);
  });

  it("removes and appends favorites without moving another instance's favorites to the front", () => {
    expect(
      replaceProviderFavoriteModels([first, second, last], CODEX_WORK_ID, [
        first.model,
        hidden.model,
      ]),
    ).toEqual([first, second, hidden]);
    expect(replaceProviderFavoriteModels([first, second, last], CODEX_WORK_ID, [])).toEqual([
      second,
    ]);
  });

  it("orders favorites within a provider while retaining non-favorite model order", () => {
    const models = [{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }];
    expect(
      sortModelsForProviderInstance(models, {
        favoriteModels: ["a", "c"],
        favoriteModelOrder: ["c", "a"],
        groupFavorites: true,
        modelOrder: ["d", "a", "b", "c"],
      }).map((m) => m.slug),
    ).toEqual(["c", "a", "d", "b"]);
    expect(
      sortProviderModelItems(
        models.map((m) => ({ ...m, instanceId: CODEX_WORK_ID })),
        {
          favoriteModelKeys: [
            providerModelKey(CODEX_WORK_ID, "a"),
            providerModelKey(CODEX_WORK_ID, "c"),
          ],
          favoriteModelOrder: [
            providerModelKey(CODEX_WORK_ID, "c"),
            providerModelKey(CODEX_WORK_ID, "a"),
          ],
          groupFavorites: true,
        },
      ).map((m) => m.slug),
    ).toEqual(["c", "a", "b", "d"]);
  });
});
