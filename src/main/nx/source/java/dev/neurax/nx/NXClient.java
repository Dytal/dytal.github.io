package dev.neurax.nx;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * NX Client v2 - the Neurax launcher's max-FPS client core.
 *
 * Design rules (deliberate, unchanged in v2):
 *  - ZERO hooks into the render pipeline: NX never registers render events,
 *    mixins or transformers, so it is compatible with Sodium, VulkanMod, Iris,
 *    ImmediatelyFast, EntityCulling and everything else.
 *  - v2 adds the ADAPTIVE BOOST ENGINE ({@link NXBoost}): every couple of
 *    seconds it steers the official video options (render distance, entity
 *    distance, particles, shadows, clouds) to hold the configured FPS target —
 *    trading quality in small logged steps under load and restoring the
 *    player's own values when headroom returns. This is how the launcher's
 *    "1000+ FPS on any device" profile stays true even on integrated graphics
 *    with hundreds of entities and 100+ chunks on screen.
 *  - Observability stays first-class: frame metrics + world-load telemetry in
 *    the game log, and the config screen via ModMenu / the launcher.
 */
public final class NXClient implements ClientModInitializer {
    public static final String VERSION = "2.0.0";
    public static final Logger LOGGER = LoggerFactory.getLogger("NX");

    // fps sampling window (fed every tick, consumed by the boost engine + logs)
    private static int samples = 0;
    private static long sampleSum = 0;
    private static int minFps = Integer.MAX_VALUE;
    private static int maxFps = 0;
    private static long windowStartMs = 0;

    private long lastLogMs = 0;
    private final NXBoost boost = new NXBoost();

    @Override
    public void onInitializeClient() {
        NXConfig.load();
        windowStartMs = System.currentTimeMillis();
        lastLogMs = windowStartMs;
        NXBoost.init();

        LOGGER.info("[NX {}] online - Neurax max-FPS client core initialized", VERSION);
        LOGGER.info("[NX] injected into this instance by the Neurax Launcher (scope: 26.1.x Fabric instances)");
        LOGGER.info("[NX] renderer/chunk/memory FPS work arrives via the bundled stack: Sodium, Lithium, Iris, C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton, Dynamic FPS");
        LOGGER.info("[NX] config: logging={}, interval={}s, boost={} (config/nx.json)",
                NXConfig.get().logging, NXConfig.get().logIntervalSeconds, NXBoost.modeName());

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            int fps = client.getFps();
            samples++;
            sampleSum += fps;
            if (fps < minFps) minFps = fps;
            if (fps > maxFps) maxFps = fps;

            // v2: the adaptive engine (one cheap pass every 2.5s inside)
            boost.tick(client);

            long now = System.currentTimeMillis();
            if (!NXConfig.get().logging) return;
            long intervalMs = Math.max(10, NXConfig.get().logIntervalSeconds) * 1000L;
            if (now - lastLogMs < intervalMs) return;

            double secs = Math.max(0.001, (now - lastLogMs) / 1000.0);
            if (samples > 0 && minFps != Integer.MAX_VALUE) {
                double avg = (double) sampleSum / samples;
                LOGGER.info("[NX] fps avg={} min={} max={} | sampled {}x over {}s | boost={} | window includes menus",
                        fmt(avg), minFps, maxFps, samples, (int) secs, NXBoost.modeName());
            } else {
                LOGGER.info("[NX] no fps samples in the last {}s", (int) secs);
            }
            resetWindow(now);
        });

        LOGGER.info("[NX] ready - frame metrics + adaptive boost engine active, config screen available via ModMenu");
    }

    /** Average FPS over the current window (0 when nothing sampled yet). */
    static int fpsWindowAverage() {
        if (samples <= 0) return 0;
        return (int) Math.round((double) sampleSum / samples);
    }

    private void resetWindow(long nowMs) {
        samples = 0;
        sampleSum = 0;
        minFps = Integer.MAX_VALUE;
        maxFps = 0;
        lastLogMs = nowMs;
        windowStartMs = nowMs;
    }

    private static String fmt(double v) {
        if (v >= 1000) return String.format("%.0f", v);
        if (v >= 100) return String.format("%.1f", v);
        return String.format("%.2f", v);
    }
}
