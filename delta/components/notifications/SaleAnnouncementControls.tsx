"use client";

import { motion } from "framer-motion";
import { PartyPopper, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/lib/store/authStore";
import { setSaleSoundOn, testSaleAnnouncement, useSaleSoundOn } from "@/lib/saleAnnouncement";

/**
 * The bell's part for closed sales (2026-10-15): try the celebration on this
 * device, and mute its sparkle and voice here. The pop-up shows either way.
 */
export function SaleAnnouncementControls() {
  const on = useSaleSoundOn();
  const name = useAuthStore((s) => s.user?.name ?? "");

  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sale closed</p>
      <div className="grid grid-cols-2 gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => testSaleAnnouncement(name)}
          className="flex items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] hover:border-primary/50 hover:text-foreground"
        >
          <PartyPopper className="h-3 w-3" /> Test
        </motion.button>
        <motion.button
          type="button"
          role="switch"
          aria-checked={on}
          whileTap={{ scale: 0.97 }}
          onClick={() => setSaleSoundOn(!on)}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px]",
            on ? "border-green-500/40 text-green-700 dark:text-green-400" : "border-border/60 text-muted-foreground hover:text-foreground",
          )}
        >
          {on ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
          {on ? "Sound & voice on" : "Muted here"}
        </motion.button>
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        Every close pops up for everybody signed in, with a sparkle and a voice. Muting is for this device only; the pop-up still shows.
      </p>
    </div>
  );
}
