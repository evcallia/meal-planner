# Stage 1: Build frontend
# --platform=$BUILDPLATFORM: run natively on the build host during multiarch
# builds (the Vite output is arch-independent) instead of under QEMU.
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-builder

WORKDIR /frontend

# Install dependencies
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

# Copy frontend source and build
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Go backend (cross-compiled natively — pure Go, CGO off)
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS backend-builder

WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
ARG TARGETOS TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# Stage 3: Minimal runtime
FROM alpine:3.20

WORKDIR /app

# CA certs for outbound HTTPS (OIDC discovery, Apple CalDAV, holiday feed);
# tzdata so time handling is correct; wget (busybox) serves the healthcheck.
RUN apk add --no-cache ca-certificates tzdata

COPY --from=backend-builder /out/server ./server

# Copy built frontend
COPY --from=frontend-builder /frontend/dist ./static

# Create non-root user
RUN adduser -D -h /home/appuser appuser
USER appuser

EXPOSE 8000

CMD ["./server"]
