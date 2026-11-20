/** Bare-phrase nav to the main capabilities menu — anchored like isVibeTradingIntent. */
export function isMenuNavigationIntent(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/^@\S+\s*/, "");
  return /^(menu|meni|meun|mneu|meny|help|options|commands|main menu|show menu|open menu|show (me )?(the )?(menu|options|capabilities|features))(\b|[!.? ])*$/.test(
    m,
  );
}
