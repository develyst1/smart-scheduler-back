import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiDocument } from "../openapi/document";

/** Swagger UI + OpenAPI JSON — public, no JWT. */
export function createDocsRoutes(specUrl: string) {
  return new Hono()
    .get("/openapi.json", (c) => c.json(openApiDocument))
    .get("/docs", swaggerUI({ url: specUrl }));
}

/** For reverse proxy: everything under /api */
export const apiDocs = createDocsRoutes("/api/openapi.json");

/** Direct to Bun port (optional): /docs at root */
export const rootDocs = createDocsRoutes("/openapi.json");
