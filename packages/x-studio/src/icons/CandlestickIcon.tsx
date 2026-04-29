import * as React from 'react';
import { ChartSvg, type IconProps } from './utils';

export function CandlestickIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const candles = [
    { x: 7, wickTop: 5, wickBot: 27, bodyTop: 10, bodyH: 10, bull: true },
    { x: 16, wickTop: 8, wickBot: 24, bodyTop: 12, bodyH: 9, bull: false },
    { x: 25, wickTop: 6, wickBot: 26, bodyTop: 9, bodyH: 12, bull: true },
  ];
  return (
    <ChartSvg size={size}>
      {candles.map((c, i) => (
        <React.Fragment key={i}>
          <line
            x1={c.x}
            y1={c.wickTop}
            x2={c.x}
            y2={c.wickBot}
            stroke={c.bull ? color : secondaryColor}
            strokeWidth={1.2}
            opacity={c.bull ? 1 : 0.55}
          />
          {c.bull ? (
            <rect x={c.x - 3} y={c.bodyTop} width={6} height={c.bodyH} rx={0.5} fill={color} />
          ) : (
            <rect
              x={c.x - 3}
              y={c.bodyTop}
              width={6}
              height={c.bodyH}
              rx={0.5}
              fill="none"
              stroke={secondaryColor}
              strokeWidth={1.2}
              opacity={0.55}
            />
          )}
        </React.Fragment>
      ))}
    </ChartSvg>
  );
}
