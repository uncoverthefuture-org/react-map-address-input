# @uncover/react-map-address-input

Address input helpers built on top of [`react-google-autocomplete`](https://www.npmjs.com/package/react-google-autocomplete), with optional Firebase/Firestore caching.

It gives you:

- **Raw access** to the original tools from `react-google-autocomplete`:
  - `ReactGoogleAutocomplete`
  - `usePlacesWidget`
  - `usePlacesAutocompleteService`
- **Extra hooks** that plug a cache pipeline in front of Google Places:
  - `useFirebasePlacesAutocompleteService` – a cache-aware wrapper around `usePlacesAutocompleteService`.
  - `useFirebaseGoogleAddress` – a higher-level hook that wires an `<input />` to predictions and full place details.

The cache pipeline can:

- Check **custom cache layers** you provide.
- Check a built-in **Firebase/Firestore cache**.
- **Only then** call the Google Places API.

---

## Install

```bash
yarn add @uncover/react-map-address-input react-google-autocomplete firebase
# or
npm install @uncover/react-map-address-input react-google-autocomplete firebase
```

### Peer dependencies

- `react` (>= 16.8.0)
- A Google Maps API key with **Places API** and **Maps JavaScript API** enabled.

---

## Firebase setup (Firestore)

Initialize Firebase and Firestore in your app (v9 modular API):

```ts
// firebaseClient.ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
};

const app = initializeApp(firebaseConfig);
export const firestore = getFirestore(app);
```

You will pass `firestore` into the hooks from this package.

---

## Quick start: `useFirebaseGoogleAddress`

This hook manages an `<input />`, queries predictions, and resolves full place
information, while using the cache pipeline to reduce Google calls.

```tsx
import React from "react";
import { firestore } from "./firebaseClient";
import {
  useFirebaseGoogleAddress,
} from "@uncover/react-map-address-input";

export function AddressInput() {
  const {
    inputProps,
    predictions,
    loading,
    selectPrediction,
    selectedPlace,
  } = useFirebaseGoogleAddress({
    firebase: { firestore },
    // Any other options supported by usePlacesAutocompleteService can go here.
  });

  return (
    <div>
      <input {...inputProps} placeholder="Search address" />

      {loading && <div>Loading...</div>}

      <ul>
        {predictions.map((prediction) => (
          <li
            key={prediction.place_id}
            onClick={async () => {
              await selectPrediction(prediction);
            }}
          >
            {prediction.description}
          </li>
        ))}
      </ul>

      {selectedPlace && (
        <pre>{JSON.stringify(selectedPlace, null, 2)}</pre>
      )}
    </div>
  );
}
```

### What this hook does

- Keeps input state in React and calls `getPlacePredictions` as you type.
- First checks your configured **cache layers** and **Firebase**.
- If nothing is cached, calls **Google Places Autocomplete Service**.
- On selection, tries to read the full place from Firebase by `placeId`, and if
  missing, calls `placesService.getDetails` and writes the result back into
  Firebase for future use.

---

## Cache pipeline

The lower-level `useFirebasePlacesAutocompleteService` hook exposes a cache
pipeline that runs **before** Google is called:

1. Each custom `cacheLayer.read()` you provide.
2. The built-in Firebase/Firestore cache layer (if configured).
3. Google Places Autocomplete Service via `usePlacesAutocompleteService`.
4. After Google responds, every `cacheLayer.write()` and the Firebase writer run.

### Cache layer shape

```ts
type CacheReadResult = {
  predictions: AutocompletePrediction[];
  fromLayer: string;
};

type CacheReadFn = (args: { input: string }) =>
  | CacheReadResult
  | null
  | Promise<CacheReadResult | null>;

type CacheWriteFn = (args: {
  input: string;
  predictions: AutocompletePrediction[];
}) => void | Promise<void>;

interface CacheLayer {
  name: string;
  read?: CacheReadFn;
  write?: CacheWriteFn;
}
```

The layers are processed in the order you provide via `cacheLayers`, followed by
an internal Firebase layer when `firebase` is configured.

### Using custom cache layers

```ts
import {
  useFirebasePlacesAutocompleteService,
} from "@uncover/react-map-address-input";

const layers: CacheLayer[] = [
  {
    name: "my-backend",
    read: async ({ input }) => {
      const res = await fetch(`/api/places-cache?input=${encodeURIComponent(input)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.predictions?.length) return null;
      return { predictions: data.predictions, fromLayer: "my-backend" };
    },
    write: async ({ input, predictions }) => {
      await fetch("/api/places-cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, predictions }),
      });
    },
  },
];

const service = useFirebasePlacesAutocompleteService({
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
  firebase: { firestore },
  cacheLayers: layers,
});
```

---

## `useFirebasePlacesAutocompleteService`

This hook wraps the original `usePlacesAutocompleteService` from
`react-google-autocomplete` and adds the cache pipeline.

```ts
const {
  placePredictions,
  getPlacePredictions,
  isPlacePredictionsLoading,
  lastResultFromCache,
  lastCacheLayerName,
  placesService,
  // ...plus everything returned by usePlacesAutocompleteService
} = useFirebasePlacesAutocompleteService({
  apiKey: YOUR_GOOGLE_MAPS_API_KEY,
  firebase: { firestore },
  cacheLayers: layers,
});
```

Key additions:

- `placePredictions`: always reflects either cached results or Google results.
- `isPlacePredictionsLoading`: loading state including cache & Google work.
- `lastResultFromCache`: `true` if the last predictions came from any cache layer.
- `lastCacheLayerName`: name of the layer that returned cached data, or `null`.

All unrecognized options are forwarded to `usePlacesAutocompleteService`.

---

## Re-exported tools from `react-google-autocomplete`

If you only need the original tools, you can import them directly from this
package:

```ts
import {
  ReactGoogleAutocomplete,
  usePlacesWidget,
  usePlacesAutocompleteService,
} from "@uncover/react-map-address-input";
```

These are just re-exports and behave exactly like the upstream package.

---

## Notes

- You are responsible for loading the Google Maps JavaScript SDK, either by
  providing an `apiKey` prop/config or by including the script tag yourself.
- The Firebase integration currently uses **Cloud Firestore**.
- Cached documents are stored by default in the `maps_addresses` collection; you
  can override this via `firebase.collectionPath`.
