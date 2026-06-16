/**
 * Reusable "locate me" geolocation toggle for a Leaflet map.
 *
 * Toggling it on watches the device's position and drops a live "you are here"
 * marker (a blue dot + a translucent accuracy circle), recentering the map on the
 * first fix so the user can see how their current location sits against their rides.
 * Toggling it off (or leaving the view) stops the watch and removes the marker.
 *
 * Rendering-agnostic and map-agnostic: it owns only its own marker + watch state
 * and the button's active styling, so both the Map view's all-rides map and the
 * Stats view's route-frequency heatmap can mount one and the interaction stays
 * identical in exactly one place. Mirrors the `createAreaSelect` pattern.
 *
 * Deliberately NOT used on the tiny per-ride preview maps — "where am I now" only
 * makes sense on the big, pannable exploration maps.
 */
import L from "leaflet";

export interface LocateOptions {
  /** Lazily resolve the Leaflet map (it is created on first mount, after this controller). */
  getMap: () => L.Map | null;
  /** The "Locate me" toggle button (its active state is managed here). */
  button: HTMLElement | null;
  /** Surface a geolocation failure (permission denied / unavailable / timeout). */
  onError?: (message: string) => void;
}

export interface Locate {
  /** Turn position-watching on or off. */
  setActive(on: boolean): void;
  /** Whether we're currently watching the device position. */
  isActive(): boolean;
}

export function createLocate(opts: LocateOptions): Locate {
  let watchId: number | null = null;
  let marker: L.CircleMarker | null = null;
  let accuracy: L.Circle | null = null;
  let centeredOnce = false;

  const setButton = (on: boolean): void => {
    const b = opts.button;
    if (!b) return;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("title", on ? "Stop showing my location" : "Show my current location");
  };

  const clearMarker = (): void => {
    marker?.remove();
    accuracy?.remove();
    marker = null;
    accuracy = null;
  };

  const onFix = (pos: GeolocationPosition): void => {
    const map = opts.getMap();
    if (!map) return;
    const here = L.latLng(pos.coords.latitude, pos.coords.longitude);
    const acc = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 0;
    if (!marker) {
      // Accuracy halo first so the dot sits above it.
      accuracy = L.circle(here, {
        radius: acc,
        color: "#2b8cff",
        weight: 1,
        opacity: 0.4,
        fillColor: "#2b8cff",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
      marker = L.circleMarker(here, {
        radius: 7,
        color: "#ffffff",
        weight: 3,
        fillColor: "#2b8cff",
        fillOpacity: 1,
        interactive: false,
      })
        .bindTooltip("You are here", { direction: "top" })
        .addTo(map);
    } else {
      marker.setLatLng(here);
      accuracy?.setLatLng(here).setRadius(acc);
    }
    // Recenter only on the first fix so we don't fight the user's panning on later
    // updates; zoom in to a neighbourhood level unless they're already closer.
    if (!centeredOnce) {
      centeredOnce = true;
      map.setView(here, Math.max(map.getZoom(), 14));
    }
  };

  const onErr = (err: GeolocationPositionError): void => {
    setActive(false);
    const msg =
      err.code === err.PERMISSION_DENIED
        ? "Location permission denied — allow it in your browser to show where you are."
        : err.code === err.POSITION_UNAVAILABLE
          ? "Your location is unavailable right now."
          : "Timed out getting your location — try again.";
    opts.onError?.(msg);
  };

  function setActive(on: boolean): void {
    if (on === (watchId !== null)) return;
    if (on) {
      if (!("geolocation" in navigator)) {
        opts.onError?.("This browser can't share your location.");
        return;
      }
      centeredOnce = false;
      setButton(true);
      watchId = navigator.geolocation.watchPosition(onFix, onErr, {
        enableHighAccuracy: true,
        maximumAge: 10_000,
        timeout: 15_000,
      });
    } else {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      clearMarker();
      setButton(false);
    }
  }

  return {
    setActive,
    isActive: () => watchId !== null,
  };
}
