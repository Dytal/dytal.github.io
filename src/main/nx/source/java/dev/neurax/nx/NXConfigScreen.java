package dev.neurax.nx;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.CycleButton;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * NX config screen - dark glass + animated four-accent header, matching the
 * launcher's UI. Vanilla widgets only (no extra deps).
 *
 * v2: controls for the adaptive BOOST engine — mode, target FPS, the three
 * adaptive levers, the render-distance floor and the crowd threshold.
 *
 * 26.x GUI note: immediate-mode rendering was replaced by the render-state
 * extraction pipeline; screens override extractRenderState(GuiGraphicsExtractor,...).
 */
public final class NXConfigScreen extends Screen {
    private static final int[] ACCENTS = {
            0xFFA855F7, // purple
            0xFF06B6D4, // cyan
            0xFF22C55E, // emerald
            0xFFF97316, // orange
    };
    private static final int TEXT_MAIN = 0xFFF2F5FA;
    private static final int TEXT_DIM = 0xFF9AA3B2;
    private static final int LINE = 0x66A855F7;

    private final Screen parent;
    private final long bornAt = System.currentTimeMillis();

    public NXConfigScreen(Screen parent) {
        super(Component.literal("NX Client"));
        this.parent = parent;
    }

    @Override
    protected void init() {
        int cx = this.width / 2;
        int bw = 240;
        int half = 116;

        NXConfig c = NXConfig.get();

        // ---- boost engine -------------------------------------------------
        this.addRenderableWidget(Button.builder(Component.literal("Boost Mode: " + cap(c.boostMode)), b -> {
                    c.boostMode = nextMode(c.boostMode);
                    NXBoost.reloadMode();
                    NXConfig.save();
                    b.setMessage(Component.literal("Boost Mode: " + cap(c.boostMode)));
                }).bounds(cx - bw / 2, 62, bw, 20)
                .build());

        this.addRenderableWidget(Button.builder(Component.literal("Target FPS: " + c.targetFps), b -> {
                    c.targetFps = c.targetFps >= 1000 ? 60 : (c.targetFps >= 500 ? 1000 : (c.targetFps >= 240 ? 500 : (c.targetFps >= 120 ? 240 : 120)));
                    NXConfig.save();
                    b.setMessage(Component.literal("Target FPS: " + c.targetFps));
                }).bounds(cx - bw / 2, 86, bw, 20)
                .build());

        this.addRenderableWidget(CycleButton.onOffBuilder(c.adaptiveRenderDistance)
                .create(cx - bw / 2 - 2, 110, half, 20, Component.literal("Adaptive Render Dist."),
                        (btn, val) -> { c.adaptiveRenderDistance = val; NXConfig.save(); }));
        this.addRenderableWidget(CycleButton.onOffBuilder(c.adaptiveEntities)
                .create(cx + 2, 110, half, 20, Component.literal("Adaptive Entities"),
                        (btn, val) -> { c.adaptiveEntities = val; NXConfig.save(); }));

        this.addRenderableWidget(CycleButton.onOffBuilder(c.adaptiveParticles)
                .create(cx - bw / 2 - 2, 134, half, 20, Component.literal("Adaptive Particles"),
                        (btn, val) -> { c.adaptiveParticles = val; NXConfig.save(); }));
        this.addRenderableWidget(CycleButton.onOffBuilder(c.enforceUnlimitedFps)
                .create(cx + 2, 134, half, 20, Component.literal("Unlimited FPS Baseline"),
                        (btn, val) -> { c.enforceUnlimitedFps = val; NXConfig.save(); }));

        this.addRenderableWidget(Button.builder(Component.literal("Min Render Distance: " + c.minRenderDistance), b -> {
                    c.minRenderDistance = c.minRenderDistance >= 16 ? 2 : c.minRenderDistance + 2;
                    NXConfig.save();
                    b.setMessage(Component.literal("Min Render Distance: " + c.minRenderDistance));
                }).bounds(cx - bw / 2, 158, bw, 20)
                .build());

        // ---- observability -------------------------------------------------
        this.addRenderableWidget(CycleButton.onOffBuilder(c.logging)
                .create(cx - bw / 2 - 2, 182, half, 20, Component.literal("FPS Logging"),
                        (btn, val) -> { c.logging = val; NXConfig.save(); }));
        this.addRenderableWidget(Button.builder(Component.literal("Log: " + c.logIntervalSeconds + "s"), b -> {
                    c.logIntervalSeconds = c.logIntervalSeconds >= 120 ? 30 : (c.logIntervalSeconds == 30 ? 60 : 120);
                    NXConfig.save();
                    b.setMessage(Component.literal("Log: " + c.logIntervalSeconds + "s"));
                }).bounds(cx + 2, 182, half, 20)
                .build());

        this.addRenderableWidget(Button.builder(Component.literal("Done"), b -> onClose())
                .bounds(cx - bw / 2, 208, bw, 20)
                .build());
    }

    private static String nextMode(String cur) {
        return switch (cur == null ? "" : cur.toLowerCase()) {
            case "turbo" -> "aggressive";
            case "aggressive" -> "balanced";
            case "balanced" -> "off";
            default -> "turbo";
        };
    }

    private static String cap(String s) {
        if (s == null || s.isEmpty()) return s;
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    @Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
        super.extractRenderState(g, mouseX, mouseY, delta);

        // animated NX header underline: cycles through the four launcher accents
        long t = System.currentTimeMillis() - bornAt;
        int slot = (int) ((t / 900) % ACCENTS.length);
        int blend = blend(ACCENTS[slot], ACCENTS[(slot + 1) % ACCENTS.length], (t % 900) / 900.0);

        int cx = this.width / 2;
        g.centeredText(this.font, "NX Client", cx, 8, TEXT_MAIN);
        g.fill(cx - 70, 21, cx + 70, 22, blend);
        g.fill(cx - 70, 21, cx - 70 + (int) (140 * ((t % 2700) / 2700.0)), 22, LINE);

        g.centeredText(this.font, "max-FPS core v" + NXClient.VERSION + " by Neurax", cx, 28, TEXT_DIM);
        g.centeredText(this.font, "boost engine: " + NXBoost.modeName() + " · target " + NXConfig.get().targetFps + " fps · zero renderer hooks", cx, 40, TEXT_DIM);
        g.centeredText(this.font, "renderer: Sodium/Iris stack - chunks: C2ME - memory: FerriteCore", cx, 52, TEXT_DIM);
    }

    private static int blend(int a, int b, double t) {
        int ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
        int r = (int) Math.round(ar + (br - ar) * t);
        int gg = (int) Math.round(ag + (bg - ag) * t);
        int bl = (int) Math.round(ab + (bb - ab) * t);
        return 0xFF000000 | (r << 16) | (gg << 8) | bl;
    }

    @Override
    public void onClose() {
        if (this.minecraft != null) this.minecraft.setScreen(parent);
    }
}
