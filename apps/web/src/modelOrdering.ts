import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

interface FavoriteModel {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

/** Swap visible neighbors without disturbing favorites hidden by the current picker. */
export function reorderFavoriteModels(
  favorites: ReadonlyArray<FavoriteModel>,
  modelKey: string,
  targetKey: string,
): ReadonlyArray<FavoriteModel> {
  const index = favorites.findIndex((f) => providerModelKey(f.provider, f.model) === modelKey);
  const targetIndex = favorites.findIndex(
    (f) => providerModelKey(f.provider, f.model) === targetKey,
  );
  if (index < 0 || targetIndex < 0 || index === targetIndex) return favorites;
  const next = [...favorites];
  [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
  return next;
}

/** Keep other instances' favorites in place when editing one instance in Settings. */
export function replaceProviderFavoriteModels(
  favorites: ReadonlyArray<FavoriteModel>,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
): FavoriteModel[] {
  const remaining = [...new Set(models)];
  const retained = new Set(remaining);
  const next: FavoriteModel[] = [];
  for (const favorite of favorites) {
    if (favorite.provider !== instanceId) {
      next.push(favorite);
    } else if (retained.has(favorite.model)) {
      const model = remaining.shift();
      if (model !== undefined) next.push({ provider: instanceId, model });
    }
  }
  return [...next, ...remaining.map((model) => ({ provider: instanceId, model }))];
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly favoriteModelOrder?: ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const favoriteOrder = rankByValue(options?.favoriteModelOrder ?? []);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((model) => favoriteModels.has(model.slug)),
          byOptionalRank<T>((model) =>
            favoriteModels.has(model.slug) ? favoriteOrder.get(model.slug) : undefined,
          ),
        ]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly favoriteModelOrder?: ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const favoriteOrder = rankByValue(options?.favoriteModelOrder ?? []);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => favoriteOrder.get(providerModelKey(item.instanceId, item.slug))),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}
