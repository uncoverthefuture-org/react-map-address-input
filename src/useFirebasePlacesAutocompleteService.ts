import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Firestore } from "firebase/firestore";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import usePlacesService from "react-google-autocomplete/lib/usePlacesAutocompleteService";

// Alias for Google autocomplete prediction type so we can refer to it in our own signatures.
export type AutocompletePrediction = google.maps.places.AutocompletePrediction;

// Configuration for the built-in Firebase cache layer.
export interface FirebasePlacesConfig {
  firestore: Firestore;
  collectionPath?: string;
}

// Result returned by a cache layer when it has data for a given input.
export interface CacheReadResult {
  predictions: AutocompletePrediction[];
  fromLayer: string;
}

// Function used by cache layers to read cached predictions.
export type CacheReadFn = (args: {
  input: string;
}) => Promise<CacheReadResult | null> | CacheReadResult | null;

// Function used by cache layers to write predictions after a Google call.
export type CacheWriteFn = (args: {
  input: string;
  predictions: AutocompletePrediction[];
}) => Promise<void> | void;

// A single cache layer in the pipeline.
export interface CacheLayer {
  name: string;
  read?: CacheReadFn;
  write?: CacheWriteFn;
}

// Configuration accepted by the Firebase-aware wrapper hook.
// All unknown properties are forwarded directly to usePlacesService.
export interface UseFirebasePlacesAutocompleteServiceOptions {
  firebase?: FirebasePlacesConfig;
  cacheLayers?: CacheLayer[];
  onAfterCacheHit?: (info: {
    layerName: string;
    input: string;
    predictions: AutocompletePrediction[];
  }) => void;
  onAfterGoogleResult?: (info: {
    input: string;
    predictions: AutocompletePrediction[];
  }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface UseFirebasePlacesAutocompleteServiceResult {
  placePredictions: AutocompletePrediction[];
  getPlacePredictions: (args: { input: string }) => void;
  isPlacePredictionsLoading: boolean;
  lastResultFromCache: boolean | null;
  lastCacheLayerName: string | null;
  // Re-expose any extra fields from the underlying hook result for advanced cases.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const DEFAULT_COLLECTION_PATH = "maps_addresses";

// Normalizes free-text input so cache keys are stable.
function normalizeInput(value: string): string {
  return value.trim().toLowerCase();
}

// Builds the built-in Firebase cache layer from configuration.
function createFirebaseLayer(
  config: FirebasePlacesConfig | undefined
): CacheLayer | null {
  if (!config?.firestore) {
    return null;
  }

  const collectionPath = config.collectionPath ?? DEFAULT_COLLECTION_PATH;

  return {
    name: "firebase",
    read: async ({ input }) => {
      const normalizedInput = normalizeInput(input);
      const colRef = collection(config.firestore, collectionPath);
      const q = query(colRef, where("normalizedInput", "==", normalizedInput));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        return null;
      }

      const predictions: AutocompletePrediction[] = [];

      snapshot.forEach((docSnap: any) => {
        const data = docSnap.data() as any;
        if (data.prediction) {
          predictions.push(data.prediction as AutocompletePrediction);
        }
      });

      if (!predictions.length) {
        return null;
      }

      return {
        predictions,
        fromLayer: "firebase",
      };
    },
    write: async ({ input, predictions }) => {
      if (!predictions.length) {
        return;
      }

      const normalizedInput = normalizeInput(input);
      const colRef = collection(config.firestore, collectionPath);

      const writes = predictions.map((prediction) => {
        const placeId =
          prediction.place_id ||
          `${normalizedInput}-${Math.random().toString(36).slice(2)}`;
        const ref = doc(colRef, placeId);

        return setDoc(
          ref,
          {
            normalizedInput,
            prediction,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      });

      await Promise.all(writes);
    },
  };
}

export function useFirebasePlacesAutocompleteService(
  options: UseFirebasePlacesAutocompleteServiceOptions
): UseFirebasePlacesAutocompleteServiceResult {
  const {
    firebase,
    cacheLayers = [],
    onAfterCacheHit,
    onAfterGoogleResult,
    ...googleConfig
  } = options;

  // Underlying hook from react-google-autocomplete that talks to Google.
  const base = usePlacesService(googleConfig);

  // Local state mirrors predictions and loading so we can override them when using cache.
  const [placePredictions, setPlacePredictions] = useState<
    AutocompletePrediction[]
  >([]);
  const [isPlacePredictionsLoading, setIsPlacePredictionsLoading] =
    useState<boolean>(false);
  const [lastResultFromCache, setLastResultFromCache] =
    useState<boolean | null>(null);
  const [lastCacheLayerName, setLastCacheLayerName] =
    useState<string | null>(null);

  // We keep track of the last input that resulted in a Google call so we can
  // persist predictions into caches once they arrive.
  const lastInputRef = useRef<string | null>(null);

  const firebaseLayer = useMemo(
    () => createFirebaseLayer(firebase),
    [firebase]
  );

  // The full ordered list of cache layers: user-defined first, then Firebase.
  const orderedLayers = useMemo<CacheLayer[]>(() => {
    const layers: CacheLayer[] = [];
    if (cacheLayers && cacheLayers.length) {
      layers.push(...cacheLayers);
    }
    if (firebaseLayer) {
      layers.push(firebaseLayer);
    }
    return layers;
  }, [cacheLayers, firebaseLayer]);

  // Ref gives us a stable view of the ordered layers inside callbacks/effects.
  const orderedLayersRef = useRef<CacheLayer[]>(orderedLayers);

  useEffect(() => {
    orderedLayersRef.current = orderedLayers;
  }, [orderedLayers]);

  // getPlacePredictions orchestrates the cache pipeline and only falls back to
  // Google if no cache layer returns data.
  const getPlacePredictions = useCallback(
    async ({ input }: { input: string }) => {
      const value = input ?? "";
      const normalized = normalizeInput(value);

      if (!normalized) {
        setPlacePredictions([]);
        setIsPlacePredictionsLoading(false);
        setLastResultFromCache(null);
        setLastCacheLayerName(null);
        // Forward the empty input to the underlying hook so it can reset itself.
        base.getPlacePredictions({ input: value });
        return;
      }

      setIsPlacePredictionsLoading(true);

      // Step 1: try each cache layer in order.
      for (const layer of orderedLayersRef.current) {
        if (!layer.read) {
          continue;
        }

        try {
          const result = await layer.read({ input: value });
          if (result && result.predictions && result.predictions.length) {
            setPlacePredictions(result.predictions);
            setIsPlacePredictionsLoading(false);
            setLastResultFromCache(true);
            setLastCacheLayerName(layer.name);

            if (onAfterCacheHit) {
              onAfterCacheHit({
                layerName: layer.name,
                input: value,
                predictions: result.predictions,
              });
            }

            return;
          }
        } catch {
          // Cache layer failures are non-fatal; we just continue to the next one.
        }
      }

      // Step 2: no cache hit; defer to Google via the underlying hook.
      setLastResultFromCache(false);
      setLastCacheLayerName(null);
      lastInputRef.current = value;
      base.getPlacePredictions({ input: value });
    },
    [base, onAfterCacheHit]
  );

  // Whenever the underlying hook updates its predictions, we mirror them into
  // local state and, if the last call was a Google request, persist them into
  // all cache layers that expose a write() function.
  useEffect(() => {
    const baseAny = base as any;
    const basePredictions =
      (baseAny.placePredictions as AutocompletePrediction[] | undefined) ?? [];
    const baseLoading = Boolean(baseAny.isPlacePredictionsLoading);

    if (!basePredictions.length && !baseLoading) {
      setIsPlacePredictionsLoading(false);
      setPlacePredictions([]);
      return;
    }

    setPlacePredictions(basePredictions);
    setIsPlacePredictionsLoading(baseLoading);

    if (!orderedLayersRef.current.length || lastResultFromCache !== false) {
      return;
    }

    const input = lastInputRef.current;
    if (!input || !basePredictions.length) {
      return;
    }

    (async () => {
      for (const layer of orderedLayersRef.current) {
        if (!layer.write) {
          continue;
        }

        try {
          await layer.write({ input, predictions: basePredictions });
        } catch {
          // Ignore cache write errors so that Google results still flow through.
        }
      }

      if (onAfterGoogleResult) {
        onAfterGoogleResult({ input, predictions: basePredictions });
      }
    })();
  }, [base, lastResultFromCache, onAfterGoogleResult]);

  return {
    ...base,
    placePredictions,
    getPlacePredictions,
    isPlacePredictionsLoading,
    lastResultFromCache,
    lastCacheLayerName,
  } as UseFirebasePlacesAutocompleteServiceResult;
}
