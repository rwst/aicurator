// AICurator native messaging host — PDF text extraction via libpoppler-glib.
//
// Wire format: Chrome native messaging. Each message is a 4-byte
// little-endian uint32 length prefix followed by a UTF-8 JSON object.
// One host process is spawned per `chrome.runtime.connectNative` port;
// the process exits when the extension closes the port (stdin EOF).
//
// Protocol:
//   { "type": "ping" }
//     -> { "type": "pong", "popplerVersion": "..." }
//   { "type": "extract", "chunkIndex": N, "totalChunks": M, "data": "<base64>" }
//     -> on last chunk: { "type": "result", "text": "..." }
//        or             { "type": "error",  "message": "..." }
//
// Build (one line, or use scripts/install-native-host.sh):
//   gcc -O2 -Wall -o aicurator-pdftotext aicurator-pdftotext.c $(pkg-config --cflags --libs poppler-glib json-glib-1.0)

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <glib.h>
#include <json-glib/json-glib.h>
#include <poppler.h>

// Hard cap per inbound message: 16 MB. Each base64-encoded chunk from
// the extension is ~683 KB (encoded 512 KB), well under this.
#define MAX_MESSAGE_BYTES (16u * 1024u * 1024u)

static int read_message_length(uint32_t *out) {
    uint8_t buf[4];
    size_t got = fread(buf, 1, 4, stdin);
    if (got == 0) return 1;          // EOF on first byte = clean shutdown
    if (got != 4) return -1;         // truncated header
    *out = (uint32_t)buf[0]
         | ((uint32_t)buf[1] << 8)
         | ((uint32_t)buf[2] << 16)
         | ((uint32_t)buf[3] << 24);
    return 0;
}

static char *read_message_body(uint32_t len) {
    char *buf = (char *)g_malloc(len + 1);
    size_t got = fread(buf, 1, len, stdin);
    if (got != len) { g_free(buf); return NULL; }
    buf[len] = '\0';
    return buf;
}

static void write_node(JsonNode *root) {
    JsonGenerator *gen = json_generator_new();
    json_generator_set_root(gen, root);
    gsize len = 0;
    char *json = json_generator_to_data(gen, &len);
    uint8_t prefix[4] = {
        (uint8_t)(len & 0xff),
        (uint8_t)((len >> 8) & 0xff),
        (uint8_t)((len >> 16) & 0xff),
        (uint8_t)((len >> 24) & 0xff),
    };
    fwrite(prefix, 1, 4, stdout);
    if (len > 0) fwrite(json, 1, len, stdout);
    fflush(stdout);
    g_free(json);
    g_object_unref(gen);
}

static void send_simple(const char *type_value, const char *key, const char *val) {
    JsonBuilder *b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, type_value);
    if (key && val) {
        json_builder_set_member_name(b, key);
        json_builder_add_string_value(b, val);
    }
    json_builder_end_object(b);
    JsonNode *root = json_builder_get_root(b);
    write_node(root);
    json_node_unref(root);
    g_object_unref(b);
}

static void send_pong(void) {
    send_simple("pong", "popplerVersion", poppler_get_version());
}

static void send_error(const char *msg) {
    send_simple("error", "message", msg ? msg : "(no message)");
}

static void send_result(const char *text) {
    send_simple("result", "text", text ? text : "");
}

// libpoppler text extraction. Concatenates per-page text in reading
// order (the same TextOutputDev poppler uses internally for the default
// pdftotext mode), separated by form-feed (\f) per pdftotext convention.
static char *extract_text(const guint8 *data, gsize len, GError **err) {
    GBytes *bytes = g_bytes_new_static(data, len);
    PopplerDocument *doc = poppler_document_new_from_bytes(bytes, NULL, err);
    g_bytes_unref(bytes);
    if (!doc) return NULL;

    int n = poppler_document_get_n_pages(doc);
    GString *out = g_string_new(NULL);
    for (int i = 0; i < n; i++) {
        PopplerPage *page = poppler_document_get_page(doc, i);
        if (!page) continue;
        char *t = poppler_page_get_text(page);
        if (t) {
            g_string_append(out, t);
            if (i + 1 < n) g_string_append_c(out, '\f');
            g_free(t);
        }
        g_object_unref(page);
    }
    g_object_unref(doc);
    return g_string_free(out, FALSE);
}

int main(void) {
    GByteArray *buffer = g_byte_array_new();
    int expected_chunks = -1;
    int received_chunks = 0;

    while (1) {
        uint32_t msg_len = 0;
        int rc = read_message_length(&msg_len);
        if (rc > 0) break;                // clean EOF
        if (rc < 0) { send_error("truncated header"); break; }
        if (msg_len == 0 || msg_len > MAX_MESSAGE_BYTES) {
            send_error("message size out of range");
            break;
        }

        char *body = read_message_body(msg_len);
        if (!body) { send_error("truncated body"); break; }

        JsonParser *parser = json_parser_new();
        GError *jerr = NULL;
        if (!json_parser_load_from_data(parser, body, msg_len, &jerr)) {
            send_error(jerr ? jerr->message : "JSON parse failed");
            if (jerr) g_error_free(jerr);
            g_object_unref(parser);
            g_free(body);
            continue;
        }

        JsonNode *root = json_parser_get_root(parser);
        if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
            send_error("expected JSON object");
            g_object_unref(parser);
            g_free(body);
            continue;
        }
        JsonObject *obj = json_node_get_object(root);
        const char *type = json_object_has_member(obj, "type")
            ? json_object_get_string_member(obj, "type") : NULL;

        if (g_strcmp0(type, "ping") == 0) {
            send_pong();
        } else if (g_strcmp0(type, "extract") == 0) {
            int idx = (int)json_object_get_int_member(obj, "chunkIndex");
            int total = (int)json_object_get_int_member(obj, "totalChunks");
            const char *data_b64 = json_object_get_string_member(obj, "data");
            if (!data_b64 || total <= 0 || idx < 0 || idx >= total) {
                send_error("malformed extract chunk");
            } else {
                if (idx == 0) {
                    g_byte_array_set_size(buffer, 0);
                    expected_chunks = total;
                    received_chunks = 0;
                }
                if (expected_chunks != total) {
                    send_error("chunk total mismatch");
                    g_byte_array_set_size(buffer, 0);
                    expected_chunks = -1;
                    received_chunks = 0;
                } else {
                    gsize raw_len = 0;
                    guchar *raw = g_base64_decode(data_b64, &raw_len);
                    g_byte_array_append(buffer, raw, raw_len);
                    g_free(raw);
                    received_chunks++;
                    if (received_chunks == expected_chunks) {
                        GError *xerr = NULL;
                        char *text = extract_text(buffer->data, buffer->len, &xerr);
                        if (text) {
                            send_result(text);
                            g_free(text);
                        } else {
                            send_error(xerr ? xerr->message : "extraction failed");
                            if (xerr) g_error_free(xerr);
                        }
                        g_byte_array_set_size(buffer, 0);
                        expected_chunks = -1;
                        received_chunks = 0;
                    }
                }
            }
        } else {
            send_error("unknown message type");
        }

        g_object_unref(parser);
        g_free(body);
    }

    g_byte_array_free(buffer, TRUE);
    return 0;
}
