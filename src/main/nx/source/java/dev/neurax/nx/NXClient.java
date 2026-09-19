package dev.neurax.nx;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * NX Client - the Neurax launcher's max-FPS client core.
 *
 * Design rules (deliberate):
 *  - ZERO hooks into the render pipeline: NX never registers render events,
 *    mixins or transformers, so it is compatible with Sodium, VulkanMod, Iris,
 *    ImmediatelyFast, EntityCulling and everything else (the real FPS work is
 *    done by the optimization stack the launcher bundles alongside NX).
 *  - NX adds the observability + control plane: frame metrics, periodic
 *    performance logs, and the config screen (ModMenu / launcher).
 *
 * FPS metrics are sampled from Minecraft#getFps() (the same 1-second value the
 * vanilla debug screen shows) once per client tick - no render-pipeline contact.
 */
public final class NXClient implements ClientModInitializer {
    public static final String VERSION = "1.0.0";
    public static final Logger LOGGER = LoggerFactory.getLogger("NX");

    private int samples = 0;
    private long sampleSum = 0;
    private int minFps = Integer.MAX_VALUE;
    private int maxFps = 0;
    private long lastLogMs = 0;

    @Override
    public void onInitializeClient() {
        NXConfig.load();
        lastLogMs = System.currentTimeMillis();

        LOGGER.info("[NX {}] online - Neurax max-FPS client core initialized", VERSION);
        LOGGER.info("[NX] injected into this instance by the Neurax Launcher (scope: 26.1.2 Fabric instances)");
        LOGGER.info("[NX] renderer/chunk/memory FPS work arrives via the bundled stack: Sodium, Lithium, Iris, C2ME, FerriteCore, ImmediatelyFast, EntityCulling, Krypton, Dynamic FPS");
        LOGGER.info("[NX] config: logging={}, interval={}s (config/nx.json)",
                NXConfig.get().logging, NXConfig.get().logIntervalSeconds);

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            int fps = client.getFps();
            samples++;
            sampleSum += fps;
            if (fps < minFps) minFps = fps;
            if (fps > maxFps) maxFps = fps;

            long now = System.currentTimeMillis();
            if (!NXConfig.get().logging) return;
            long intervalMs = Math.max(10, NXConfig.get().logIntervalSeconds) * 1000L;
            if (now - lastLogMs < intervalMs) return;

            double secs = Math.max(0.001, (now - lastLogMs) / 1000.0);
            if (samples > 0 && minFps != Integer.MAX_VALUE) {
                double avg = (double) sampleSum / samples;
                LOGGER.info("[NX] fps avg={} min={} max={} | sampled {}x over {}s | window includes menus",
                        fmt(avg), minFps, maxFps, samples, (int) secs);
            } else {
                LOGGER.info("[NX] no fps samples in the last {}s", (int) secs);
            }
            resetWindow(now);
        });

        LOGGER.info("[NX] ready - frame metrics active, config screen available via ModMenu");
    }

    private void resetWindow(long nowMs) {
        samples = 0;
        sampleSum = 0;
        minFps = Integer.MAX_VALUE;
        maxFps = 0;
        lastLogMs = nowMs;
    }

    private static String fmt(double v) {
        if (v >= 1000) return String.format("%.0f", v);
        if (v >= 100) return String.format("%.1f", v);
        return String.format("%.2f", v);
    }
}
