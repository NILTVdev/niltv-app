import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient, defaultShouldDehydrateQuery } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";

/** One app-wide client — importable outside React (auth store clears "me" on sign-out). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "niltv.queryCache",
});

/**
 * AsyncStorage persistence for warm launches (design §3.2). Queries flagged
 * `meta.noPersist` (the authenticated "me" query) are never dehydrated.
 */
export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  persister,
  buster: "v1",
  maxAge: 24 * 60 * 60 * 1000,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && query.meta?.noPersist !== true,
  },
};
