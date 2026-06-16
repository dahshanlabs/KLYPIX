import { AgentRobot } from '../../components/AgentRobot';

// Small KLYPIX presence in the canvas top-right: the real chat AgentRobot
// (helmet + swaying antenna + glowing eyes + spinning gear), scaled down, over a
// "press /" label. Transparent, no box, pointer-through — points the user at the
// slash-command bar. Reuses the chat character instead of a bespoke one so the
// brand mascot stays consistent everywhere.

const ROBOT_SCALE = 0.68;

export function CommandHint() {
    return (
        <div className="absolute top-3 right-5 z-20 no-drag pointer-events-none select-none flex flex-col items-center">
            {/* Fixed box contains the scaled robot so the label sits snug beneath
                it (a transform doesn't shrink the layout box on its own). Height
                is tuned to the gear-less robot so the text tucks in close. */}
            <div className="flex items-start justify-center" style={{ width: 32, height: 27 }}>
                <div style={{ transform: `scale(${ROBOT_SCALE})`, transformOrigin: 'top center' }}>
                    <AgentRobot isWorking showGear={false} />
                </div>
            </div>
            <div className="font-semibold tracking-wide" style={{ color: '#10b981', fontSize: 9, marginTop: -1 }}>
                press <span className="font-bold">"/"</span>
            </div>
        </div>
    );
}
