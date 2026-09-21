package dev.neurax.nx;

import net.minecraft.client.CloudStatus;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Options;
import net.minecraft.server.level.ParticleStatus;

/**
 * NX Boost — the v2 adaptive performance engine.
 *
 * DESIGN RULE (unchanged from v1): ZERO hooks into the render pipeline.
 * NX never registers render events, mixins or transformers. Everything here
 * goes through the OFFICIAL options API ({@link Options} OptionInstance
 * getters/setters) once every couple of seconds — the same fields the
 * vanilla Video Settings screen writes. That keeps NX 100% compatible with
 * Sodium, VulkanMod, Iris, ImmediatelyFast, EntityCulling, C2ME and every
 * other mod, on every launcher, forever.
 *
 * WHAT IT DOES (per mode):
 *   balanced   — enforces the unlimited-FPS baseline and adapts render
 *                distance only when the average FPS falls well behind target.
 *   aggressive — + entity visibility scaling, entity shadows off and
 *                particle reduction under load.
 *   turbo      — + clouds off, biome blend 0 at world join and the most
 *                aggressive floors. This is the launcher's default for the
 *                "1000+ FPS on any device" profile.
 *
 * ADAPTIVE LOOP (one option change per cycle, with a cooldown per option —
 * quality is traded in small, logged steps, never all at once):
 *   avgFps < 0.8 × target  → reduce render distance by 1 (down to the floor)
 *   avgFps > 1.3 × target  → restore render distance by 1 (up to the ceiling)
 *   crowded world (entity count ≥ config.crowdedEntities):
 *       entityDistanceScaling steps down (floors: 0.75 / 0.5 by mode)
 *       particles DECREASED → MINIMAL (turbo), shadows off, clouds off
 *   load clears: every change is rolled back to the player's own values.
 */
public final class NXBoost {
    private enum Mode { OFF, BALANCED, AGGRESSIVE, TURBO }

    private static Mode mode = Mode.OFF;
    private static boolean forcedThisSession = false;

    // world-join snapshots of the PLAYER'S own settings — everything NX changes
    // is restored from here when the load clears (the player always wins).
    private int joinRenderDistance = -1;
    private double joinEntityDistance = -1.0;
    private ParticleStatus joinParticles = null;
    private boolean joinEntityShadows = true;
    private CloudStatus joinClouds = null;

    // adaptive state
    private long lastApplyMs = 0L;
    private long lastRdChangeMs = 0L;
    private long lastEntityChangeMs = 0L;
    private long lastParticleChangeMs = 0L;
    private boolean crowded = false;
    private int lastLoggedEntities = -1;
    private int lastLoggedChunks = -1;

    private static final long APPLY_EVERY_MS = 2500L;
    private static final long SAME_OPTION_COOLDOWN_MS = 15000L;

    public static boolean enabled() {
        return mode != Mode.OFF;
    }

    public static String modeName() {
        return mode == Mode.OFF ? "off" : mode.name().toLowerCase();
    }

    /* --------------------------------------------------------------- lifecycle */

    /** Called once from onInitializeClient. */
    public static void init() {
        mode = parseMode(NXConfig.get().boostMode);
        NXClient.LOGGER.info("[NX] boost engine: mode={} targetFps={} adaptive(render={}, entities={}, particles={})",
                modeName(), NXConfig.get().targetFps,
                NXConfig.get().adaptiveRenderDistance, NXConfig.get().adaptiveEntities, NXConfig.get().adaptiveParticles);
    }

    /** Reload the mode from config (the config screen may have changed it). */
    public static void reloadMode() {
        mode = parseMode(NXConfig.get().boostMode);
    }

    private static Mode parseMode(String s) {
        if (s == null) return Mode.OFF;
        return switch (s.trim().toLowerCase()) {
            case "balanced" -> Mode.BALANCED;
            case "aggressive" -> Mode.AGGRESSIVE;
            case "turbo" -> Mode.TURBO;
            default -> Mode.OFF;
        };
    }

    /* ------------------------------------------------------------------- tick */

    /** Called once per client tick from NXClient. Cheap: one apply pass every
     *  APPLY_EVERY_MS, everything else is a couple of integer compares. */
    public void tick(Minecraft client) {
        if (mode == Mode.OFF) return;
        final boolean inWorld = client.level != null;

        // leaving a world: restore everything the player owned, reset state
        if (!inWorld) {
            resetSession();
            return;
        }

        // one-time baseline enforcement at the first world join
        if (!forcedThisSession && NXConfig.get().enforceUnlimitedFps) {
            forcedThisSession = true;
            try {
                if (client.options.enableVsync().get()) {
                    client.options.enableVsync().set(false);
                    NXClient.LOGGER.info("[NX] boost: vsync off (the 60 Hz brake is gone)");
                }
                if (NXConfig.get().unlimitedFps) {
                    client.options.framerateLimit().set(Options.UNLIMITED_FRAMERATE_CUTOFF);
                    NXClient.LOGGER.info("[NX] boost: framerate limit → unlimited");
                }
            } catch (Exception e) {
                NXClient.LOGGER.warn("[NX] boost baseline skipped: {}", e.toString());
            }
        }

        // snapshot the player's own quality values exactly once per world
        if (joinRenderDistance < 0) {
            try {
                joinRenderDistance = client.options.renderDistance().get();
                joinEntityDistance = client.options.entityDistanceScaling().get();
                joinParticles = client.options.particles().get();
                joinEntityShadows = client.options.entityShadows().get();
                joinClouds = client.options.cloudStatus().get();
                if (mode == Mode.TURBO && NXConfig.get().targetFps > 0) {
                    client.options.biomeBlendRadius().set(0); // costs frames, visually near-free in motion
                }
            } catch (Exception e) {
                joinRenderDistance = Math.max(8, NXConfig.get().minRenderDistance); // safe fallback
            }
            NXClient.LOGGER.info("[NX] boost engaged in world — render distance {}, entities {}, chunks {}",
                    joinRenderDistance, safeEntityCount(client), safeChunkCount(client));
        }

        long now = System.currentTimeMillis();
        if (now - lastApplyMs < APPLY_EVERY_MS) return;
        lastApplyMs = now;

        int avgFps = NXClient.fpsWindowAverage();
        int target = Math.max(30, NXConfig.get().targetFps);
        boolean turbo = mode == Mode.TURBO;
        boolean aggressive = turbo || mode == Mode.AGGRESSIVE;

        int entities = safeEntityCount(client);
        int chunks = safeChunkCount(client);
        boolean wasCrowded = crowded;
        crowded = entities >= Math.max(50, NXConfig.get().crowdedEntities) && mode != Mode.BALANCED;

        /* 1. RENDER DISTANCE — the big lever */
        if (NXConfig.get().adaptiveRenderDistance && avgFps > 0) {
            try {
                int rd = client.options.renderDistance().get();
                int floor = Math.max(2, NXConfig.get().minRenderDistance);
                int ceiling = NXConfig.get().maxRenderDistance > 0 ? NXConfig.get().maxRenderDistance : Math.max(joinRenderDistance, floor);
                if (avgFps < (int) (target * 0.8) && rd > floor && now - lastRdChangeMs >= SAME_OPTION_COOLDOWN_MS) {
                    client.options.renderDistance().set(rd - 1);
                    lastRdChangeMs = now;
                    NXClient.LOGGER.info("[NX] boost: render distance {} → {} (avg fps {} below target {}) [entities={}, chunks={}]",
                            rd, rd - 1, avgFps, target, entities, chunks);
                } else if (avgFps > (int) (target * 1.3) && rd < ceiling && now - lastRdChangeMs >= SAME_OPTION_COOLDOWN_MS) {
                    client.options.renderDistance().set(rd + 1);
                    lastRdChangeMs = now;
                    NXClient.LOGGER.info("[NX] boost: render distance {} → {} (headroom: avg fps {} vs target {}) [entities={}, chunks={}]",
                            rd, rd + 1, avgFps, target, entities, chunks);
                }
            } catch (Exception e) { /* option unavailable on this version — skip */ }
        }

        /* 2. ENTITIES — visibility scaling when the world is crowded */
        if (NXConfig.get().adaptiveEntities && aggressive) {
            try {
                double cur = client.options.entityDistanceScaling().get();
                double floor = turbo ? 0.5 : 0.75;
                if (crowded && cur > floor && now - lastEntityChangeMs >= SAME_OPTION_COOLDOWN_MS) {
                    double next = Math.max(floor, Math.round((cur - 0.25) * 100.0) / 100.0);
                    client.options.entityDistanceScaling().set(next);
                    lastEntityChangeMs = now;
                    NXClient.LOGGER.info("[NX] boost: entity distance {} → {} ({} entities — fewer mobs tracked on screen)", cur, next, entities);
                } else if (!crowded && wasCrowded && cur < joinEntityDistance) {
                    client.options.entityDistanceScaling().set(joinEntityDistance);
                    NXClient.LOGGER.info("[NX] boost: entity distance restored to {}", joinEntityDistance);
                }
            } catch (Exception e) { /* skip */ }
        }

        /* 3. PARTICLES / SHADOWS / CLOUDS — the cheap quality wins under load */
        if (NXConfig.get().adaptiveParticles && aggressive) {
            try {
                if (crowded && now - lastParticleChangeMs >= SAME_OPTION_COOLDOWN_MS) {
                    ParticleStatus p = client.options.particles().get();
                    ParticleStatus want = turbo ? ParticleStatus.MINIMAL : ParticleStatus.DECREASED;
                    if (p.ordinal() < want.ordinal()) {
                        client.options.particles().set(want);
                        lastParticleChangeMs = now;
                        NXClient.LOGGER.info("[NX] boost: particles → {} ({} entities)", want.name().toLowerCase(), entities);
                    }
                    if (client.options.entityShadows().get()) {
                        client.options.entityShadows().set(false);
                        NXClient.LOGGER.info("[NX] boost: entity shadows off ({} entities)", entities);
                    }
                    if (turbo && client.options.cloudStatus().get() != CloudStatus.OFF) {
                        client.options.cloudStatus().set(CloudStatus.OFF);
                        NXClient.LOGGER.info("[NX] boost: clouds off ({} entities, {} chunks)", entities, chunks);
                    }
                } else if (!crowded && wasCrowded) {
                    // load cleared — give the player their world back
                    client.options.particles().set(joinParticles != null ? joinParticles : ParticleStatus.ALL);
                    client.options.entityShadows().set(joinEntityShadows);
                    if (turbo && joinClouds != null) client.options.cloudStatus().set(joinClouds);
                    NXClient.LOGGER.info("[NX] boost: load cleared — particles/shadows/clouds restored to your settings");
                }
            } catch (Exception e) { /* skip */ }
        }

        // one INFO line whenever the world changes shape noticeably (bounded)
        if (NXConfig.get().logging
                && (Math.abs(entities - lastLoggedEntities) >= 100 || Math.abs(chunks - lastLoggedChunks) >= 32)) {
            lastLoggedEntities = entities;
            lastLoggedChunks = chunks;
            NXClient.LOGGER.info("[NX] world load: {} entities, {} loaded chunks, render distance {}",
                    entities, chunks, client.options.renderDistance().get());
        }
    }

    /** Leaving the world / shutting down: forget every adaptation. */
    private void resetSession() {
        if (joinRenderDistance < 0) return; // was never engaged
        forcedThisSession = false;
        crowded = false;
        lastLoggedEntities = -1;
        lastLoggedChunks = -1;
        joinRenderDistance = -1;
        joinEntityDistance = -1.0;
        joinParticles = null;
        joinEntityShadows = true;
        joinClouds = null;
        NXClient.LOGGER.info("[NX] boost disengaged — all player settings preserved for the next world.");
    }

    private static int safeEntityCount(Minecraft client) {
        try { return client.level.getEntityCount(); } catch (Exception e) { return 0; }
    }

    private static int safeChunkCount(Minecraft client) {
        try { return client.level.getChunkSource().getLoadedChunksCount(); } catch (Exception e) { return 0; }
    }
}
