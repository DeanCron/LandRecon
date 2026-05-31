import './MapPageSkeleton.css'

// Lightweight skeleton shown while the MapPage chunk is downloading. Mirrors
// the production layout (header, map area, bottom FABs) so users get a
// stable shape instead of a white flash on slow 4G.
export default function MapPageSkeleton() {
  return (
    <div className="map-skeleton" role="status" aria-live="polite" aria-label="Loading map">
      <div className="map-skeleton-header">
        <div className="map-skeleton-pill map-skeleton-shimmer" style={{ width: 56 }} />
        <div className="map-skeleton-pill map-skeleton-shimmer map-skeleton-grow" />
        <div className="map-skeleton-pill map-skeleton-shimmer" style={{ width: 36 }} />
      </div>
      <div className="map-skeleton-canvas map-skeleton-shimmer">
        <div className="map-skeleton-canvas-overlay" />
      </div>
      <div className="map-skeleton-fabs">
        <div className="map-skeleton-fab map-skeleton-shimmer" />
        <div className="map-skeleton-fab map-skeleton-shimmer" />
      </div>
    </div>
  )
}
