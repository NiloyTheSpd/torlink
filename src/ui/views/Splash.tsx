import { Box, Text, useInput, useStdin } from "ink";
import { Logo } from "../components/Logo";
import { UpdateBanner } from "../components/UpdateBanner";
import { SearchBar } from "../components/SearchBar";
import { LOGO_WIDTH } from "../logo";
import { useStore } from "../store";
import { sourcesByGroup } from "../../sources/registry";
import { COLOR, ICON } from "../theme";

const CATEGORIES = sourcesByGroup()
  .map((g) => g.group.toLowerCase())
  .join(`  ${ICON.dot}  `);

export function Splash({
  updateVersion,
  recovered,
}: { updateVersion?: string | null; recovered?: boolean } = {}) {
  const { submitQuery, quitAll, cols, rows } = useStore();
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) quitAll();
    },
    { isActive: isRawModeSupported },
  );

  const showLogo = cols >= LOGO_WIDTH + 2;
  const barWidth = Math.max(24, Math.min(cols - 6, 62));

  return (
    <Box
      height={Math.max(1, rows - 1)}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <UpdateBanner latest={updateVersion ?? null} />
      {recovered ? (
        <Text dimColor>{`↻ recovered from a crashed start · downloads paused`}</Text>
      ) : null}
      <Box flexDirection="column">
        <Text bold color={COLOR.accent}>
           █████  ██████   █████  ██████  
        </Text>
        <Text bold color={COLOR.accent}>
          ██     ██      ██ ██   ██ ██   ██ 
        </Text>
        <Text bold color={COLOR.accent}>
          ██     ██████  ███████ ██████  
        </Text>
        <Text bold color={COLOR.accent}>
          ██ ███ ██      ██   ██ ██   ██ 
        </Text>
        <Text bold color={COLOR.accent}>
           █████  ██      ██   ██ ██████  
        </Text>
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
      <Box marginTop={1}>
        <Text>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> search</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>⇥</Text>
          <Text dimColor> browse</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>^c</Text>
          <Text dimColor> quit</Text>
        </Text>
      </Box>
    </Box>
  );
}
