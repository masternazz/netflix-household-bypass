import { Composition } from "remotion";
import { NetworkDiagram } from "./NetworkDiagram";

export const MyComposition = () => {
  return (
    <Composition
      id="NetworkDiagram"
      component={NetworkDiagram}
      durationInFrames={330}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
