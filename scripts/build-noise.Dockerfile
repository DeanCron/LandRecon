# Builder image for airport-noise.pmtiles.
#
# Bundles GDAL (gdal_contour, ogr2ogr) and tippecanoe so the build script in
# scripts/build_noise_pmtiles.py can run on any host that has Docker.
#
# Build:
#   docker build -f scripts/build-noise.Dockerfile -t landrecon-noise-builder scripts
#
# Run (Windows PowerShell example):
#   docker run --rm `
#     -v C:/Temp/CONUS_aviation_noise_2020/COG:/src:ro `
#     -v ${PWD}/build:/work `
#     landrecon-noise-builder `
#       --src-dir /src --work-dir /work --out /work/airport-noise.pmtiles
#
# The PMTiles file lands in ./build/airport-noise.pmtiles on the host.

FROM ghcr.io/osgeo/gdal:ubuntu-small-3.8.4

ARG TIPPECANOE_VERSION=2.51.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        build-essential \
        libsqlite3-dev \
        zlib1g-dev \
        python3 \
    && git clone --depth 1 --branch ${TIPPECANOE_VERSION} \
        https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && make -C /tmp/tippecanoe -j"$(nproc)" \
    && make -C /tmp/tippecanoe install \
    && rm -rf /tmp/tippecanoe \
    && apt-get purge -y git build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY build_noise_pmtiles.py /opt/build_noise_pmtiles.py

ENTRYPOINT ["python3", "/opt/build_noise_pmtiles.py"]
CMD ["--help"]
