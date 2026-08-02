import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./Panel";
import { PromptHints } from "./PromptHints";
import { COLOR, ICON } from "../theme";
import { truncate } from "../../util/format";

export interface VideoFormatOption {
  value: string;
  label: string;
  detail?: string;
}

interface VideoFormatPromptProps {
  width: number;
  title: string;
  subtitle?: string;
  options: VideoFormatOption[];
  onSelect: (option: VideoFormatOption) => void;
  onCancel: () => void;
}

export function VideoFormatPrompt({
  width,
  title,
  subtitle,
  options,
  onSelect,
  onCancel,
}: VideoFormatPromptProps) {
  const [cursor, setCursor] = useState(0);
  const clamped = Math.min(Math.max(cursor, 0), options.length - 1);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setCursor((prev) => (prev === 0 ? options.length - 1 : prev - 1));
    } else if (key.downArrow || input === "j") {
      setCursor((prev) => (prev === options.length - 1 ? 0 : prev + 1));
    } else if (key.return) {
      onSelect(options[clamped]);
    } else if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <Panel title={title} width={width} focused height={Math.max(6, options.length + 3)}>
        {subtitle ? (
          <Box>
            <Text dimColor wrap="truncate-end">
              {truncate(subtitle, width - 4)}
            </Text>
          </Box>
        ) : null}
        {options.map((option, index) => {
          const selected = index === clamped;
          return (
            <Box key={option.value}>
              <Text color={selected ? COLOR.accent : COLOR.text} bold={selected}>
                {selected ? ICON.pointer : "  "}
              </Text>
              <Text color={selected ? COLOR.accent : undefined} bold={selected}>
                {option.label}
              </Text>
              <Text dimColor>{option.detail ? `  ${truncate(option.detail, width - option.label.length - 8)}` : ""}</Text>
            </Box>
          );
        })}
      </Panel>
      <Box marginTop={1}>
        <PromptHints submitLabel="download" />
      </Box>
    </Box>
  );
}
