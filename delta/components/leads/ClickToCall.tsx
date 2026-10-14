"use client";

import { motion } from "framer-motion";
import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCallFlow, dialOf } from "@/components/calls/CallFlow";

interface ClickToCallProps {
  phoneNumber: string;
  leadId?: string;
  leadName?: string;
  variant?: "ghost" | "outline";
  size?: "icon" | "sm";
  showLabel?: boolean;
  className?: string;
}

/**
 * The Call button (2026-10-14): asks "3CX call" (3CX rings your own 3CX app, then dials the lead; a call window
 * follows it) or "Phone call" (tel:), then — for a lead — "How did the call go?". All of it lives in the call flow
 * (components/calls/CallFlow.tsx), mounted once by the dashboard layout.
 */
export function ClickToCall({
  phoneNumber,
  leadId,
  leadName,
  variant = "ghost",
  size = "icon",
  showLabel = false,
  className = "",
}: ClickToCallProps) {
  const flow = useCallFlow();
  if (!phoneNumber) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            onPointerDown={(e) => e.stopPropagation()}   // not a drag on a kanban card
            onClick={(e) => {
              e.stopPropagation();
              if (flow) flow.chooseCall({ leadId, leadName, phone: phoneNumber });
              else window.location.href = `tel:${dialOf(phoneNumber)}`;
            }}
            className={`${className} text-green-400 hover:text-green-300 hover:bg-green-500/10`}
          >
            <motion.div whileTap={{ scale: 0.9 }}>
              <Phone className="h-4 w-4" />
            </motion.div>
            {showLabel && <span className="ml-2">Call</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          Call {leadName || phoneNumber}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
