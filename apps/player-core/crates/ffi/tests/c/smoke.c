/* C ABI smoke test (PLAYER §11): create -> callback -> open .lep -> Playing ->
 * preview sequence -> diagnostics -> stop -> Idle -> destroy. */
#include "rgbprompt_player.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
static void sleep_ms(int ms) {
    Sleep((DWORD)ms);
}
#else
#include <unistd.h>
static void sleep_ms(int ms) {
    usleep((useconds_t)ms * 1000);
}
#endif

#define PREVIEW_BYTES (104 * 3)
#define PLAYING 4
#define IDLE 0

static volatile int last_state = -1;
static volatile int last_error = 0;
static volatile int last_driver_error = 0;

static void on_state(const RgbpStateEvent *event, void *user) {
    (void)user;
    if (event == NULL) {
        return;
    }
    last_state = event->state;
    last_error = event->error;
    last_driver_error = event->driver_error;
}

static int wait_for_state(int wanted, int attempts) {
    for (int i = 0; i < attempts; i++) {
        if (last_state == wanted) {
            return 1;
        }
        sleep_ms(20);
    }
    return last_state == wanted;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: smoke <lep-path> <openrgb-port>\n");
        return 2;
    }

    char addr[64];
    snprintf(addr, sizeof(addr), "127.0.0.1:%d", atoi(argv[2]));

    RgbpConfig config;
    memset(&config, 0, sizeof(config));
    config.data_dir = "/tmp/rgbprompt-smoke";
    config.api_base = "http://127.0.0.1:1";
    config.platform = "mac";
    config.language = "en";
    config.app_version = "0.3.0";
    config.os_version = "macOS 14.2";
    config.openrgb_addr = addr;

    RgbpHandle *handle = rgbp_create(&config);
    if (handle == NULL) {
        fprintf(stderr, "smoke: rgbp_create failed\n");
        return 1;
    }

    if (rgbp_abi_version() != RGBP_ABI_VERSION) {
        fprintf(stderr, "smoke: ABI version %u, expected %u\n", rgbp_abi_version(),
                RGBP_ABI_VERSION);
        rgbp_destroy(handle);
        return 1;
    }

    if (rgbp_set_state_callback(handle, on_state, NULL) != RGBP_OK) {
        fprintf(stderr, "smoke: set_state_callback failed\n");
        rgbp_destroy(handle);
        return 1;
    }

    if (rgbp_open_lep_file(handle, argv[1]) != RGBP_OK) {
        fprintf(stderr, "smoke: open_lep_file failed\n");
        rgbp_destroy(handle);
        return 1;
    }

    if (!wait_for_state(PLAYING, 250)) {
        fprintf(stderr, "smoke: never reached Playing (state %d, error %d)\n", last_state,
                last_error);
        rgbp_destroy(handle);
        return 1;
    }

    uint8_t frame[PREVIEW_BYTES];
    int64_t first = rgbp_preview_frame(handle, frame);
    sleep_ms(150);
    int64_t second = rgbp_preview_frame(handle, frame);
    if (first < 0 || second <= first) {
        fprintf(stderr, "smoke: preview sequence did not advance (%lld -> %lld)\n",
                (long long)first, (long long)second);
        rgbp_destroy(handle);
        return 1;
    }

    char diagnostics[8192];
    int diagnostics_len = rgbp_diagnostics_json(handle, diagnostics, sizeof(diagnostics));
    if (diagnostics_len <= 0 || diagnostics[0] != '{' ||
        (size_t)diagnostics_len >= sizeof(diagnostics)) {
        fprintf(stderr, "smoke: diagnostics failed (%d)\n", diagnostics_len);
        rgbp_destroy(handle);
        return 1;
    }

    char driver_info[4096];
    int driver_info_len = rgbp_driver_info_json(handle, driver_info, sizeof(driver_info));
    if (driver_info_len <= 0 || driver_info[0] != '{' ||
        (size_t)driver_info_len >= sizeof(driver_info)) {
        fprintf(stderr, "smoke: driver info failed (%d)\n", driver_info_len);
        rgbp_destroy(handle);
        return 1;
    }

    if (last_driver_error != 0) {
        fprintf(stderr, "smoke: unexpected driver error %d\n", last_driver_error);
        rgbp_destroy(handle);
        return 1;
    }

    if (rgbp_stop(handle) != RGBP_OK) {
        fprintf(stderr, "smoke: stop failed\n");
        rgbp_destroy(handle);
        return 1;
    }

    if (!wait_for_state(IDLE, 250)) {
        fprintf(stderr, "smoke: never returned to Idle (state %d)\n", last_state);
        rgbp_destroy(handle);
        return 1;
    }

    rgbp_destroy(handle);
    printf("smoke: ok (playing, seq %lld -> %lld, diagnostics %d bytes, driver info %d bytes)\n",
           (long long)first, (long long)second, diagnostics_len, driver_info_len);
    return 0;
}
