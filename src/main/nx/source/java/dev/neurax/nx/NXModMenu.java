package dev.neurax.nx;

import com.terraformersmc.modmenu.api.ConfigScreenFactory;
import com.terraformersmc.modmenu.api.ModMenuApi;

/**
 * ModMenu integration - the NX entry in the Mods list opens the NX config screen.
 */
public final class NXModMenu implements ModMenuApi {
    @Override
    public ConfigScreenFactory<?> getModConfigScreenFactory() {
        return NXConfigScreen::new;
    }
}
