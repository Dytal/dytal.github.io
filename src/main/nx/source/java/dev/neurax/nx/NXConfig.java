package dev.neurax.nx;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * NX config - a deliberately tiny, version-proof JSON file at config/nx.json.
 * gson is shipped by Minecraft itself, so no extra runtime dependency exists.
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
