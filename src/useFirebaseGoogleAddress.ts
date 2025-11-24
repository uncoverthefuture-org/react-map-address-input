import { useCallback, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import {
  type AutocompletePrediction,
  type FirebasePlacesConfig,
  type UseFirebasePlacesAutocompleteServiceOptions,
  useFirebasePlacesAutocompleteService,
} from "./useFirebasePlacesAutocompleteService";

const DEFAULT_COLLECTION_PATH = "maps_addresses";

export interface UseFirebaseGoogleAddressOptions
  extends UseFirebasePlacesAutocompleteServiceOptions {
  minSearchLength?: number;
}

export interface UseFirebaseGoogleAddressResult {
  inputValue: string;
  inputProps: {
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  predictions: AutocompletePrediction[];
  loading: boolean;
  selectPrediction: (
    prediction: AutocompletePrediction
  ) => Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    place: any | null;
    fromCache: boolean;
    cacheLayerName: string | null;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedPlace: any | null;
  lastResultFromCache: boolean | null;
  lastCacheLayerName: string | null;
}

export function useFirebaseGoogleAddress(
  options: UseFirebaseGoogleAddressOptions
): UseFirebaseGoogleAddressResult {
  const { firebase, minSearchLength = 3, ...rest } = options;

  // Reuse the cache-aware service hook so we get the full cache pipeline
  // (custom layers + Firebase + Google) for free.
  const service = useFirebasePlacesAutocompleteService({
    firebase,
    ...rest,
  });

  const [inputValue, setInputValue] = useState<string>("");
  const [selectedPlace, setSelectedPlace] = useState<any | null>(null);
  const [isSelecting, setIsSelecting] = useState<boolean>(false);

  const loading = service.isPlacePredictionsLoading || isSelecting;

  // onChange handler that keeps local input state in sync and triggers
  // predictions when the minimum search length is reached.
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInputValue(value);

      if (value.length < minSearchLength) {
        service.getPlacePredictions({ input: "" });
        return;
      }

      service.getPlacePredictions({ input: value });
    },
    [minSearchLength, service]
  );

  // Helper that resolves a full place object from either Firebase cache or
  // Google Places details endpoint.
  const selectPrediction = useCallback(
    async (prediction: AutocompletePrediction) => {
      if (!prediction || !prediction.place_id) {
        return { place: null, fromCache: false, cacheLayerName: null };
      }

      setIsSelecting(true);

      try {
        const placeId = prediction.place_id;
        const firestore = (firebase as FirebasePlacesConfig | undefined)?.firestore;
        const collectionPath =
          (firebase as FirebasePlacesConfig | undefined)?.collectionPath ??
          DEFAULT_COLLECTION_PATH;

        // Step 1: try to read full place details from Firebase by placeId.
        if (firestore) {
          const ref = doc(collection(firestore, collectionPath), placeId);
          const snap = await getDoc(ref);

          if (snap.exists()) {
            const data = snap.data() as any;
            if (data.rawPlace) {
              setSelectedPlace(data.rawPlace);
              setIsSelecting(false);
              return {
                place: data.rawPlace,
                fromCache: true,
                cacheLayerName: "firebase",
              };
            }
          }
        }

        // Step 2: fall back to Google Places details API via placesService.
        const placesService =
          (service as any).placesService as
            | google.maps.places.PlacesService
            | null
            | undefined;

        if (!placesService) {
          setIsSelecting(false);
          return { place: null, fromCache: false, cacheLayerName: null };
        }

        const place = await new Promise<any | null>((resolve) => {
          placesService.getDetails(
            {
              placeId,
            },
            (result: any, status: any) => {
              if (
                status === google.maps.places.PlacesServiceStatus.OK &&
                result
              ) {
                resolve(result);
              } else {
                resolve(null);
              }
            }
          );
        });

        if (!place) {
          setIsSelecting(false);
          return { place: null, fromCache: false, cacheLayerName: null };
        }

        setSelectedPlace(place);

        // Step 3: persist full place details back into Firebase for future use.
        if (firestore) {
          const colRef = collection(firestore, collectionPath);
          const ref = doc(colRef, placeId);

          await setDoc(
            ref,
            {
              rawPlace: place,
              formattedAddress: place.formatted_address ?? null,
              location:
                place.geometry && place.geometry.location
                  ? {
                      lat: place.geometry.location.lat(),
                      lng: place.geometry.location.lng(),
                    }
                  : null,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        }

        setIsSelecting(false);

        return {
          place,
          fromCache: false,
          cacheLayerName: service.lastResultFromCache
            ? service.lastCacheLayerName
            : null,
        };
      } catch {
        setIsSelecting(false);
        return { place: null, fromCache: false, cacheLayerName: null };
      }
    },
    [firebase, service]
  );

  const inputProps = useMemo(
    () => ({
      value: inputValue,
      onChange: handleChange,
    }),
    [handleChange, inputValue]
  );

  return {
    inputValue,
    inputProps,
    predictions: service.placePredictions as AutocompletePrediction[],
    loading,
    selectPrediction,
    selectedPlace,
    lastResultFromCache: service.lastResultFromCache,
    lastCacheLayerName: service.lastCacheLayerName,
  };
}
