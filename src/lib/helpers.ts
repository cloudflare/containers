/**
 * Parse a time expression into seconds
 * @param timeExpression Time expression (number or string like "5m", "30s", "1h")
 * @returns Number of seconds
 */
export function parseTimeExpression(timeExpression: string | number): number {
  if (typeof timeExpression === 'number') {
    // If it's already a number, assume it's in seconds
    return timeExpression;
  }

  if (typeof timeExpression === 'string') {
    // Parse time expressions like "5m", "30s", "1h"
    const match = timeExpression.match(/^(\d+)([smh])$/);
    if (!match) {
      throw new Error(`invalid time expression ${timeExpression}`);
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    // Convert to seconds based on unit
    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 60 * 60;
      default:
        throw new Error(`unknown time unit ${unit}`);
    }
  }

  throw new Error(`invalid type for a time expression: ${typeof timeExpression}`);
}
