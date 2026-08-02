import { Box, Text, useInput, useStdin } from "ink";
import { Logo } from "../components/Logo";
import { SearchBar } from "../components/SearchBar";
import { LOGO_WIDTH } from "../logo";
import { useStore } from "../store";

export function Splash({}: { updateVersion?: string | null; recovered?: boolean } = {}) {
  const { submitQuery, quitAll, cols, rows } = useStore();
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) quitAll();
    },
    { isActive: isRawModeSupported },
  );

  const barWidth = Math.max(24, Math.min(cols - 6, 62));

  return (
    <Box
      height={Math.max(1, rows - 1)}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <Box flexDirection="column" alignItems="center">
        <Logo />
      </Box>

      <Box marginTop={2} width={barWidth}>
        <SearchBar
          width={barWidth}
          value=""
          editing
          placeholder="Search or paste a magnet link…"
          onSubmit={submitQuery}
          onExitDown={() => submitQuery("")}
        />
      </Box>
    </Box>
  );
}
