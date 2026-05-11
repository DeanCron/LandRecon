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
- **Leaflet** for interactive maps
- **React Router** for client-side routing
- **Nominatim** (OpenStreetMap) for geocoding and address autocomplete

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
