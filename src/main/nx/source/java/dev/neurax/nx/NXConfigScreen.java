package dev.neurax.nx;

import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.CycleButton;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * NX config screen - dark glass + animated four-accent header, matching the
 * launcher's futuristic UI pack. Vanilla widgets only (no extra deps).
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

        NXConfig c = NXConfig.get();

        this.addRenderableWidget(CycleButton.onOffBuilder(c.logging)
                .create(cx - bw / 2, 66, bw, 20, Component.literal("FPS Logging"),
                        (btn, val) -> {
                            c.logging = val;
                            NXConfig.save();
                        }));

        // interval cycler (30s -> 60s -> 120s) as a plain button - stable across versions
        this.addRenderableWidget(Button.builder(Component.literal("Log Interval: " + c.logIntervalSeconds + "s"), b -> {
                    c.logIntervalSeconds = c.logIntervalSeconds >= 120 ? 30 : (c.logIntervalSeconds == 30 ? 60 : 120);
                    NXConfig.save();
                    b.setMessage(Component.literal("Log Interval: " + c.logIntervalSeconds + "s"));
                }).bounds(cx - bw / 2, 92, bw, 20)
                .build());

        this.addRenderableWidget(CycleButton.onOffBuilder(c.unlimitedFps)
                .create(cx - bw / 2, 118, bw, 20, Component.literal("Unlimited FPS Target"),
                        (btn, val) -> {
                            c.unlimitedFps = val;
                            NXConfig.save();
                        }));

        this.addRenderableWidget(Button.builder(Component.literal("Done"), b -> onClose())
                .bounds(cx - bw / 2, 152, bw, 20)
                .build());
    }

    @Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
        super.extractRenderState(g, mouseX, mouseY, delta);

        // animated NX header underline: cycles through the four launcher accents
        long t = System.currentTimeMillis() - bornAt;
        int slot = (int) ((t / 900) % ACCENTS.length);
        int blend = blend(ACCENTS[slot], ACCENTS[(slot + 1) % ACCENTS.length], (t % 900) / 900.0);

        int cx = this.width / 2;
        g.centeredText(this.font, "NX Client", cx, 12, TEXT_MAIN);
        g.fill(cx - 70, 25, cx + 70, 26, blend);
        g.fill(cx - 70, 25, cx - 70 + (int) (140 * ((t % 2700) / 2700.0)), 26, LINE);

        g.centeredText(this.font, "max-FPS core v" + NXClient.VERSION + " by Neurax", cx, 34, TEXT_DIM);
        g.centeredText(this.font, "renderer FPS: Sodium/Iris stack - chunks: C2ME - memory: FerriteCore", cx, 46, TEXT_DIM);
        g.centeredText(this.font, "NX adds zero renderer hooks: fully compatible with Sodium AND VulkanMod", cx, 58, TEXT_DIM);
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
