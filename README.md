# Land Recon

A web app for exploring U.S. land data and map layers by street address.

## Getting Started

```bash
npm install
npm run dev
```

## Tech Stack

- **React 19** with TypeScript
- **Vite** for dev server and bundling
- **Leaflet** for interactive maps, with **Google Maps Tiles** (street + satellite basemaps) and **PMTiles** for offline-friendly airport-noise contours
- **React Router** for client-side routing
- **TomTom** Search API for geocoding, address autocomplete, and live traffic-flow tiles
- **Google Places API** for transit stops, hospital/ER, and Costco lookups
- **EPA ArcGIS** services for Superfund site boundaries

## Project Structure

```
src/
  App.tsx          # Route definitions
  main.tsx         # App entry point
  index.css        # Global styles / CSS variables
  pages/
    HomePage.tsx   # Address search with autocomplete
    MapPage.tsx    # Map view with geocoded marker
```
