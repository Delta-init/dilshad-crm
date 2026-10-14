"use client";

import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { listItemVariants } from "@/lib/animations";

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: number | string;
  hint: string;
  /** Text colour for the icon and the number, e.g. "text-amber-500". */
  tone: string;
}

/** A number with an icon and a line of context — put several in a grid with listContainerVariants. */
export function StatCard({ icon: Icon, label, value, hint, tone }: StatCardProps) {
  return (
    <motion.div variants={listItemVariants} whileHover={{ y: -2 }} className="h-full">
      <Card className="h-full border-border/50">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Icon className={cn("h-4 w-4", tone)} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={cn("text-xl font-bold", tone)}>{value}</p>
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
