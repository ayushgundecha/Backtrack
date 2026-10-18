'use client';

import { PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { TimeScrubber } from './TimeScrubber';
import { WorldPanel } from './WorldPanel';

/** Between 1024 and 1279 px the world panel moves into a drawer so graph and run stream get 50/50. */
export function WorldDrawer() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary" size="lg" className="hidden lg:inline-flex xl:hidden">
          <PanelRight aria-hidden />
          World
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[360px] gap-0 sm:max-w-[360px]">
        <SheetHeader className="border-b">
          <SheetTitle>World</SheetTitle>
          <SheetDescription>The customers, orders and records the agents act on.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <WorldPanel />
        </div>
        <div className="shrink-0 border-t p-4">
          <TimeScrubber />
        </div>
      </SheetContent>
    </Sheet>
  );
}
