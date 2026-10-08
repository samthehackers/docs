export type PresetKind = "prompt" | "background" | "outfit" | "style";

export const BUILTIN_PRESETS: { id: string; name: string; kind: PresetKind; prompt: string; needsImage?: boolean }[] = [
  { id: "anime", name: "Anime", kind: "style", prompt: "Turn the person into a hand-drawn anime character, vibrant colors, clean line art" },
  { id: "background", name: "Background swap", kind: "background", prompt: "Keep the person exactly as they are and place them on a sunny tropical beach", needsImage: false },
  { id: "outfit", name: "Outfit", kind: "outfit", prompt: "Dress the person in a sharp tailored navy suit with a white shirt" },
  { id: "style", name: "Oil painting", kind: "style", prompt: "Render everything as a thick-brushstroke oil painting" },
];

export const TYPE_BY_KIND: Record<PresetKind, "face" | "background" | "outfit" | "style" | "custom"> = {
  prompt: "custom", background: "background", outfit: "outfit", style: "style",
};
