/*
 * pdfium_render: rasterize every page of a PDF to a PNG file (8-bit RGB).
 *
 *   pdfium_render <input.pdf> <output_prefix> <dpi>
 *
 * Writes <output_prefix>-<n>.png (n = 1-based page index) and prints one
 * line per page: "page <n> <width_px> <height_px> <rotation>".
 * Rotation is the page's /Rotate value (0/90/180/270) as applied by PDFium.
 *
 * Built against the official PDFium C API (fpdfview.h). Output is an RGB PNG
 * with an opaque white background, one page at a time, so memory stays bounded.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fpdfview.h"
#include "fpdf_edit.h"
#include <zlib.h>

/* Minimal PNG writer: 8-bit RGB, no interlace, filter type 0 on every scanline,
 * IDAT data compressed with zlib's compress2. */
static void be32(unsigned char *p, unsigned v) {
    p[0] = (unsigned char)(v >> 24); p[1] = (unsigned char)(v >> 16);
    p[2] = (unsigned char)(v >> 8); p[3] = (unsigned char)v;
}

static unsigned crc_table[256];
static int crc_ready = 0;
static unsigned crc32_update(unsigned crc, const unsigned char *b, size_t n) {
    if (!crc_ready) {
        for (unsigned i = 0; i < 256; i++) {
            unsigned c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            crc_table[i] = c;
        }
        crc_ready = 1;
    }
    crc = ~crc;
    for (size_t i = 0; i < n; i++) crc = crc_table[(crc ^ b[i]) & 0xFF] ^ (crc >> 8);
    return ~crc;
}

static int write_chunk(FILE *f, const char *type, const unsigned char *data, unsigned len) {
    unsigned char hdr[8];
    be32(hdr, len);
    memcpy(hdr + 4, type, 4);
    if (fwrite(hdr, 1, 8, f) != 8) return 0;
    if (len && fwrite(data, 1, len, f) != len) return 0;
    unsigned crc = crc32_update(0, (const unsigned char *)type, 4);
    if (len) crc = crc32_update(crc, data, len);
    unsigned char c[4];
    be32(c, crc);
    return fwrite(c, 1, 4, f) == 4;
}

static int write_png(const char *path, const unsigned char *rgb, int w, int h) {
    size_t raw_len = (size_t)h * (1 + (size_t)w * 3);
    unsigned char *raw = (unsigned char *)malloc(raw_len);
    if (!raw) return 0;
    for (int y = 0; y < h; y++) {
        raw[(size_t)y * (1 + w * 3)] = 0; /* filter: none */
        memcpy(raw + (size_t)y * (1 + w * 3) + 1, rgb + (size_t)y * w * 3, (size_t)w * 3);
    }
    uLongf zlen = compressBound((uLong)raw_len);
    unsigned char *z = (unsigned char *)malloc(zlen);
    if (!z || compress2(z, &zlen, raw, (uLong)raw_len, 6) != Z_OK) {
        free(raw); free(z); return 0;
    }
    free(raw);
    unsigned char ihdr[13];
    be32(ihdr, (unsigned)w);
    be32(ihdr + 4, (unsigned)h);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    FILE *f = fopen(path, "wb");
    if (!f) { free(z); return 0; }
    static const unsigned char sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    int ok = fwrite(sig, 1, 8, f) == 8
          && write_chunk(f, "IHDR", ihdr, 13)
          && write_chunk(f, "IDAT", z, (unsigned)zlen)
          && write_chunk(f, "IEND", NULL, 0);
    fclose(f);
    free(z);
    return ok;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        FPDF_LIBRARY_CONFIG check_cfg;
        check_cfg.version = 2;
        check_cfg.m_pUserFontPaths = NULL;
        check_cfg.m_pIsolate = NULL;
        check_cfg.m_v8EmbedderSlot = 0;
        check_cfg.m_pPlatform = NULL;
        FPDF_InitLibraryWithConfig(&check_cfg);
        FPDF_DestroyLibrary();
        printf("pdfium-render ok\n");
        return 0;
    }
    if (argc != 4 && argc != 5) {
        fprintf(stderr, "usage: %s <input.pdf> <output_prefix> <dpi> [max_pages]\n", argv[0]);
        return 2;
    }
    const char *in = argv[1];
    const char *prefix = argv[2];
    double dpi = atof(argv[3]);
    long max_pages = (argc == 5) ? atol(argv[4]) : 0; /* 0 = no limit */
    if (dpi <= 0 || max_pages < 0) {
        fprintf(stderr, "invalid dpi or max_pages\n");
        return 2;
    }

    FPDF_LIBRARY_CONFIG cfg;
    cfg.version = 2;
    cfg.m_pUserFontPaths = NULL;
    cfg.m_pIsolate = NULL;
    cfg.m_v8EmbedderSlot = 0;
    cfg.m_pPlatform = NULL;
    FPDF_InitLibraryWithConfig(&cfg);

    FPDF_DOCUMENT doc = FPDF_LoadDocument(in, NULL);
    if (!doc) {
        fprintf(stderr, "load failed: error %lu\n", FPDF_GetLastError());
        FPDF_DestroyLibrary();
        return 3;
    }

    int pages = FPDF_GetPageCount(doc);
    /* First line: the document's total page count, so the caller can refuse
     * an oversized document before any rendering. */
    printf("pages %d\n", pages);
    if (max_pages > 0 && pages > max_pages) {
        pages = (int)max_pages;
    }
    for (int i = 0; i < pages; i++) {
        FPDF_PAGE page = FPDF_LoadPage(doc, i);
        if (!page) {
            fprintf(stderr, "page %d load failed\n", i + 1);
            FPDF_CloseDocument(doc);
            FPDF_DestroyLibrary();
            return 4;
        }
        double pw = FPDF_GetPageWidthF(page);
        double ph = FPDF_GetPageHeightF(page);
        int rot = FPDFPage_GetRotation(page);
        int w = (int)(pw * dpi / 72.0 + 0.5);
        int h = (int)(ph * dpi / 72.0 + 0.5);

        FPDF_BITMAP bmp = FPDFBitmap_Create(w, h, 0);
        if (!bmp) {
            fprintf(stderr, "bitmap create failed page %d\n", i + 1);
            FPDF_ClosePage(page);
            FPDF_CloseDocument(doc);
            FPDF_DestroyLibrary();
            return 5;
        }
        FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xFFFFFFFF);
        FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, FPDF_ANNOT);

        /* PDFium stores BGRA (4 bytes/pixel) with stride. Convert to RGB. */
        const unsigned char *src = (const unsigned char *)FPDFBitmap_GetBuffer(bmp);
        int stride = FPDFBitmap_GetStride(bmp);
        unsigned char *rgb = (unsigned char *)malloc((size_t)w * h * 3);
        if (!rgb) {
            fprintf(stderr, "out of memory\n");
            FPDFBitmap_Destroy(bmp);
            FPDF_ClosePage(page);
            FPDF_CloseDocument(doc);
            FPDF_DestroyLibrary();
            return 6;
        }
        for (int y = 0; y < h; y++) {
            const unsigned char *row = src + (size_t)y * stride;
            unsigned char *out = rgb + (size_t)y * w * 3;
            for (int x = 0; x < w; x++) {
                out[x * 3 + 0] = row[x * 4 + 2];
                out[x * 3 + 1] = row[x * 4 + 1];
                out[x * 3 + 2] = row[x * 4 + 0];
            }
        }

        char path[4096];
        snprintf(path, sizeof(path), "%s-%d.png", prefix, i + 1);
        int ok = write_png(path, rgb, w, h);
        free(rgb);
        FPDFBitmap_Destroy(bmp);
        FPDF_ClosePage(page);
        if (!ok) {
            fprintf(stderr, "write failed: %s\n", path);
            FPDF_CloseDocument(doc);
            FPDF_DestroyLibrary();
            return 7;
        }
        printf("page %d %d %d %d\n", i + 1, w, h, rot);
    }

    FPDF_CloseDocument(doc);
    FPDF_DestroyLibrary();
    return 0;
}
