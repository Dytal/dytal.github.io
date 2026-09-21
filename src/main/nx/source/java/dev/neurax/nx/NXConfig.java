package dev.neurax.nx;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * NX config - a deliberately tiny, version-proof JSON file at config/nx.json.
 * gson is shipped by Minecraft itself, so no extra runtime dependency exists.
 *
 * v2 — the adaptive FPS engine (NX Boost) is configured from here. Every
 * option maps 1:1 to a slider in the NX config screen (ModMenu) and the
 * launcher can pre-seed the file when it injects the mod.
 */
public final class NXConfig {
    /** Periodic [NX] performance lines in the game log. */
    public boolean logging = true;
    /** Seconds between two [NX] fps log lines. */
    public int logIntervalSeconds = 60;
    /** Intent mirror of the launcher's "unlimited FPS" target (the launcher sets maxFps in options.txt). */
    public boolean unlimitedFps = true;
    /** UI accent: auto | purple | emerald | cyan | orange (kept in sync by the launcher theme). */
    public String themeAccent = "auto";

    /* -------------------------------------------------- v2: NX BOOST ------- */
    /** Adaptive engine: off | balanced | aggressive | turbo (launcher default: turbo). */
    public String boostMode = "turbo";
    /** The FPS number NX Boost defends. When the average drops below ~80% of
     * this, render distance is traded for frames; when it climbs back above
     * ~130%, quality is restored step by step. */
    public int targetFps = 240;
    /** Render distance is never lowered below this (vanilla chunks stay playable). */
    public int minRenderDistance = 5;
    /** Upper limit NX may restore the render distance to. 0 = the value the
     * player had when the world was joined. */
    public int maxRenderDistance = 0;
    /** Trade render distance for FPS under load (the single biggest lever). */
    public boolean adaptiveRenderDistance = true;
    /** Shrink how far entities are visible (and rendered) when the world is crowded. */
    public boolean adaptiveEntities = true;
    /** Drop particles (then shadows, then clouds) while under heavy load. */
    public boolean adaptiveParticles = true;
    /** Enforce vsync off + unlimited framerate when a world is joined. */
    public boolean enforceUnlimitedFps = true;
    /** Entity count above which the world counts as "crowded". */
    public int crowdedEntities = 150;

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static NXConfig instance;

    private static Path file() {
        return FabricLoader.getInstance().getConfigDir().resolve("nx.json");
    }

    public static NXConfig get() {
        if (instance == null) load();
        return instance;
    }

    public static void load() {
        NXConfig c = new NXConfig();
        try {
            Path f = file();
            if (Files.exists(f)) {
                NXConfig read = GSON.fromJson(Files.readString(f), NXConfig.class);
                if (read != null) c = read;
            }
        } catch (Exception e) {
            NXClient.LOGGER.warn("[NX] config unreadable, using defaults: {}", e.toString());
        }
        instance = c;
        save();
    }

    public static void save() {
        try {
            Path f = file();
            if (f.getParent() != null) Files.createDirectories(f.getParent());
            Files.writeString(f, GSON.toJson(instance));
        } catch (Exception e) {
            NXClient.LOGGER.warn("[NX] config save failed: {}", e.toString());
        }
    }
}
