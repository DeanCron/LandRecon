import './MapPageSkeleton.css'

interface MapPageSkeletonProps {
  failed?: boolean
}

// Lightweight skeleton shown while the MapPage chunk is downloading. Mirrors
// the production layout (header, map area, bottom FABs) so users get a
// stable shape instead of a white flash on slow 4G.
export default function MapPageSkeleton({ failed = false }: MapPageSkeletonProps) {
  return (
    <div
      className="map-skeleton"
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      aria-label={failed ? 'Map failed to load' : 'Loading map'}
    >
      <div className="map-skeleton-header">
        <div className={`map-skeleton-pill${failed ? '' : ' map-skeleton-shimmer'}`} style={{ width: 56 }} />
        <div className={`map-skeleton-pill map-skeleton-grow${failed ? '' : ' map-skeleton-shimmer'}`} />
        <div className={`map-skeleton-pill${failed ? '' : ' map-skeleton-shimmer'}`} style={{ width: 36 }} />
      </div>
      <div className={`map-skeleton-canvas${failed ? '' : ' map-skeleton-shimmer'}`}>
        <div className="map-skeleton-canvas-overlay" />
        {failed && (
          <div className="map-skeleton-error">
            <strong>LandRecon couldn't finish loading.</strong>
            <p>The app may have updated while this page was open, or the connection was interrupted.</p>
            <div className="map-skeleton-error-actions">
              <button type="button" onClick={() => window.location.reload()}>Reload</button>
              <a href="/">Back home</a>
            </div>
          </div>
        )}
      </div>
      {!failed && (
        <div className="map-skeleton-fabs">
          <div className="map-skeleton-fab map-skeleton-shimmer" />
          <div className="map-skeleton-fab map-skeleton-shimmer" />
        </div>
      )}
    </div>
  )
}
