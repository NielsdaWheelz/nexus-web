// The glyph lexicon: one drawing, one gloss. The object comes from the label or the
// place, so one sign covers many objects without saying two things.
//
// Consumers write `import * as Icon from "@/lib/ui/icons"` and name a sign. Never a
// computed `Icon[name]`, never a dynamic lucide import, never lucide itself: a consumer
// depends on the name, not the drawing, so a drawing changes here in one line. Every
// export is decorative, paints currentColor, and takes `className` and `size`. A new
// export is paid for by a bare use: a sign read alone on a control, as a type or as a
// place. A menu row never earns one; with no sign it keeps its blank slot. Size belongs
// to the slot (`--control-icon-size`, `.menuItemIcon`); waiting belongs to `control.tsx`.
import {
  ALargeSmall,
  ArrowDown,
  ArrowUp,
  Bold as BoldDrawing,
  CalendarDays,
  ChartColumn,
  Check as CheckDrawing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleArrowUp,
  CircleUser,
  CloudOff,
  CodeXml,
  Compass,
  Copy as CopyDrawing,
  Download as DownloadDrawing,
  Ellipsis,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Globe,
  Headphones,
  Highlighter,
  Italic as ItalicDrawing,
  Keyboard as KeyboardDrawing,
  LayoutList,
  Library as LibraryDrawing,
  Link as LinkDrawing,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListTree,
  LocateFixed,
  Lock,
  Map as MapDrawing,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  Minus,
  Moon,
  NotebookTabs,
  Palette,
  PanelRight,
  Pause as PauseDrawing,
  Play as PlayDrawing,
  Plus,
  Podcast as PodcastDrawing,
  Quote,
  Redo2,
  RotateCw,
  Rss,
  Save as SaveDrawing,
  Scroll,
  Search as SearchDrawing,
  Send as SendDrawing,
  Settings as SettingsDrawing,
  Share2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  StickyNote,
  Strikethrough as StrikethroughDrawing,
  Sun,
  TriangleAlert,
  Underline as UnderlineDrawing,
  Undo2,
  Upload as UploadDrawing,
  User,
  Users,
  X,
  ZoomIn as ZoomInDrawing,
  ZoomOut as ZoomOutDrawing,
  createLucideIcon,
} from "lucide-react";
import type { LucideIcon, LucideProps } from "lucide-react";

export type Glyph = LucideIcon;

// The name is the gloss. The comment is the promise.

// Signs that promise a consequence.
export const Dismiss: Glyph = X;                      // take this away; nothing saved is lost
export const Remove: Glyph = Minus;                   // one fewer here; the thing survives
export const Stop: Glyph = Square;                    // halt what is running; what is done stays
export const Again: Glyph = RotateCw;                 // run it once more
export const Undo: Glyph = Undo2;                     // take that back
export const Redo: Glyph = Redo2;                     // put it back

// Verbs.
export const Add: Glyph = Plus;                       // one more here
export const Save: Glyph = SaveDrawing;               // keep this
export const Maximize: Glyph = Maximize2;             // this alone
export const Restore: Glyph = Minimize2;              // back among the others
export const ZoomIn: Glyph = ZoomInDrawing;           // closer
export const ZoomOut: Glyph = ZoomOutDrawing;         // further
export const Copy: Glyph = CopyDrawing;               // duplicate to the clipboard
export const Share: Glyph = Share2;                   // give others a way in
export const Send: Glyph = SendDrawing;               // hand it over
export const Download: Glyph = DownloadDrawing;       // keep a copy here
export const Upload: Glyph = UploadDrawing;           // bring it in
export const Search: Glyph = SearchDrawing;           // look for it
export const Filter: Glyph = SlidersHorizontal;       // narrow this
export const Link: Glyph = LinkDrawing;               // join these
export const Show: Glyph = Eye;                       // make it visible
export const Hide: Glyph = EyeOff;                    // conceal it; it stays
export const Locate: Glyph = LocateFixed;             // go to the spot
export const MoveUp: Glyph = ArrowUp;                 // move the thing up
export const MoveDown: Glyph = ArrowDown;             // move the thing down
export const Indent: Glyph = ListIndentIncrease;      // one level in
export const Outdent: Glyph = ListIndentDecrease;     // one level out
export const More: Glyph = Ellipsis;                  // more commands

// Transport.
export const Play: Glyph = PlayDrawing;               // sound on
export const Pause: Glyph = PauseDrawing;             // sound held
export const Previous: Glyph = SkipBack;              // previous entry
export const Next: Glyph = SkipForward;               // next entry

// Direction.
export const Left: Glyph = ChevronLeft;               // more that way
export const Right: Glyph = ChevronRight;             // more that way
export const Up: Glyph = ChevronUp;                   // more that way
export const Down: Glyph = ChevronDown;               // more that way
export const Choose: Glyph = ChevronsUpDown;          // opens a choice

// Formatting.
export const Bold: Glyph = BoldDrawing;                   // bold
export const Italic: Glyph = ItalicDrawing;               // italic
export const Underline: Glyph = UnderlineDrawing;         // underline
export const Strikethrough: Glyph = StrikethroughDrawing; // strike
export const Code: Glyph = CodeXml;                       // code

// Nouns. A noun on a control means open or start that noun with this subject.
export const WebText: Glyph = Scroll;                 // continuous text, no pages
export const Page: Glyph = FileText;                  // a page
export const Note: Glyph = StickyNote;                // your words
export const Passage: Glyph = Quote;                  // its words
export const Highlight: Glyph = Highlighter;          // a marked passage
export const Library: Glyph = LibraryDrawing;         // a collection
export const Chat: Glyph = MessageSquare;             // a conversation
export const NewChat: Glyph = MessageSquarePlus;      // a conversation not yet begun
export const Forks: Glyph = GitBranch;                // branches of a conversation
export const Podcast: Glyph = PodcastDrawing;         // a show
export const Feed: Glyph = Rss;                       // a feed
export const SourceReference: Glyph = NotebookTabs;   // a reference in the source
export const Web: Glyph = Globe;                      // a saved web page
export const Author: Glyph = User;                    // a person who wrote it
export const Members: Glyph = Users;                  // people in this library
export const Account: Glyph = CircleUser;             // you

// Places.
export const UpNext: Glyph = LayoutList;              // what plays next
export const Chapters: Glyph = ListOrdered;           // the parts of this episode
export const Contents: Glyph = ListTree;              // the parts of this work
export const Today: Glyph = CalendarDays;             // the daily page
export const Browse: Glyph = Compass;                 // look outside your library
export const Oracle: Glyph = Sparkles;                // a reading
export const Atlas: Glyph = MapDrawing;               // the map of your library
export const Stats: Glyph = ChartColumn;              // your numbers
export const Player: Glyph = Headphones;              // the player
export const Inspector: Glyph = PanelRight;           // the side panel
export const Settings: Glyph = SettingsDrawing;       // how it behaves
export const Appearance: Glyph = Palette;             // how it looks
export const ReaderSettings: Glyph = ALargeSmall;     // how text reads
export const Keyboard: Glyph = KeyboardDrawing;       // the keys
export const Light: Glyph = Sun;                      // light theme
export const Dark: Glyph = Moon;                      // dark theme

// Marks.
export const Check: Glyph = CheckDrawing;             // this holds
export const Warning: Glyph = TriangleAlert;          // needs a look
export const Blocked: Glyph = Lock;                   // not allowed
export const Offline: Glyph = CloudOff;               // no connection
export const UpdateReady: Glyph = CircleArrowUp;      // a new version is ready

// Drawn glyphs carry a nexus- name, so their class never matches a stock glyph.
// The lectern: a closed desk with converging sides, a ledge, a post and splayed legs.
// Its axis sits 0.75 off centre so every edge lands on a pixel at 1x.
export const Lectern: Glyph = /*#__PURE__*/ createLucideIcon("nexus-lectern", [ // what you are working through
  ["path", { d: "M5.25 3.75h12l2 9h-16z", key: "desk" }],
  ["path", { d: "M4.25 8.25h14", key: "ledge" }],
  ["path", { d: "M11.25 12.75v6", key: "post" }],
  ["path", { d: "M7.5 21 11.25 18.75 15 21", key: "legs" }],
]);
// The compounds slim the desk to make room; the plus overshoots the keyline by 0.75.
export const AddToLectern: Glyph = /*#__PURE__*/ createLucideIcon("nexus-add-to-lectern", [ // onto the Lectern
  ["path", { d: "M4.5 3.75h9l1.5 9H3z", key: "desk" }],
  ["path", { d: "M3.75 8.25h10.5", key: "ledge" }],
  ["path", { d: "M9 12.75v6", key: "post" }],
  ["path", { d: "M5.25 21 9 18.75l3.75 2.25", key: "legs" }],
  ["path", { d: "M15.75 15.75h6", key: "across" }],
  ["path", { d: "M18.75 12.75v6", key: "upright" }],
]);
export const RemoveFromLectern: Glyph = /*#__PURE__*/ createLucideIcon("nexus-remove-from-lectern", [ // off the Lectern; the item survives
  ["path", { d: "M4.5 3.75h9l1.5 9H3z", key: "desk" }],
  ["path", { d: "M3.75 8.25h10.5", key: "ledge" }],
  ["path", { d: "M9 12.75v6", key: "post" }],
  ["path", { d: "M5.25 21 9 18.75l3.75 2.25", key: "legs" }],
  ["path", { d: "M15.75 15.75h6", key: "across" }],
]);
// The skips: lucide's rotate arcs around numerals drawn as rounded rectilinear outlines,
// 7.75 tall, clear of the arrowhead by a stroke at 20px. The only anticlockwise arc left.
export const SeekBack15: Glyph = /*#__PURE__*/ createLucideIcon("nexus-seek-back-15", [ // fifteen seconds back
  ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", key: "arc" }],
  ["path", { d: "M3 3v5h5", key: "head" }],
  ["path", { d: "M8 10.75 9 9.75v7.75", key: "one" }],
  ["path", { d: "M15.5 9.75h-4V13h3a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-3", key: "five" }],
]);
export const SeekForward30: Glyph = /*#__PURE__*/ createLucideIcon("nexus-seek-forward-30", [ // thirty seconds on
  ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", key: "arc" }],
  ["path", { d: "M21 3v5h-5", key: "head" }],
  ["path", { d: "M7.5 9.75h3a.75.75 0 0 1 .75.75v6.25a.75.75 0 0 1-.75.75h-3M8.75 13.625h2.5", key: "three" }],
  ["rect", { x: "12.75", y: "9.75", width: "3.75", height: "7.75", rx: "1.875", key: "zero" }],
]);

// Disclosure: closed points right, open points down, by state, in place. The turn is
// glyph-internal so no owner draws a second chevron; reduced motion zeroes the duration.
export function Disclose({ open, style, ...props }: LucideProps & { readonly open: boolean }) { // more that way, in place
  return <ChevronRight {...props} style={{ ...style, transform: open ? "rotate(90deg)" : undefined,
    transition: "transform var(--duration-fast) var(--ease-glide)" }} />;
}
