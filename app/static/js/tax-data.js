/**
 * 2025 Federal and State Tax Data
 * Federal: IRS Revenue Procedure 2024-40 (2025 tax year)
 * State: 2024/2025 published rates
 */
window.TAX_DATA = {
    year: 2025,

    federal: {
        brackets: {
            single: [
                { min: 0, max: 11925, rate: 0.10 },
                { min: 11925, max: 48475, rate: 0.12 },
                { min: 48475, max: 103350, rate: 0.22 },
                { min: 103350, max: 197300, rate: 0.24 },
                { min: 197300, max: 250525, rate: 0.32 },
                { min: 250525, max: 626350, rate: 0.35 },
                { min: 626350, max: Infinity, rate: 0.37 }
            ],
            married: [
                { min: 0, max: 23850, rate: 0.10 },
                { min: 23850, max: 96950, rate: 0.12 },
                { min: 96950, max: 206700, rate: 0.22 },
                { min: 206700, max: 394600, rate: 0.24 },
                { min: 394600, max: 501050, rate: 0.32 },
                { min: 501050, max: 751600, rate: 0.35 },
                { min: 751600, max: Infinity, rate: 0.37 }
            ]
        },
        standardDeduction: {
            single: 15000,
            married: 30000
        }
    },

    fica: {
        socialSecurity: { rate: 0.062, cap: 176100 },
        medicare: { rate: 0.0145, additionalRate: 0.009, additionalThreshold: 200000 },
        selfEmployment: { rate: 0.153, deductibleHalf: 0.5, netEarningsMultiplier: 0.9235 }
    },

    states: {
        "AL": { name: "Alabama", type: "bracket", brackets: [
            { min: 0, max: 500, rate: 0.02 },
            { min: 500, max: 3000, rate: 0.04 },
            { min: 3000, max: Infinity, rate: 0.05 }
        ]},
        "AK": { name: "Alaska", type: "none" },
        "AZ": { name: "Arizona", type: "flat", rate: 0.025 },
        "AR": { name: "Arkansas", type: "bracket", brackets: [
            { min: 0, max: 4400, rate: 0.02 },
            { min: 4400, max: 8800, rate: 0.04 },
            { min: 8800, max: Infinity, rate: 0.044 }
        ]},
        "CA": { name: "California", type: "bracket", brackets: [
            { min: 0, max: 10412, rate: 0.01 },
            { min: 10412, max: 24684, rate: 0.02 },
            { min: 24684, max: 38959, rate: 0.04 },
            { min: 38959, max: 54081, rate: 0.06 },
            { min: 54081, max: 68350, rate: 0.08 },
            { min: 68350, max: 349137, rate: 0.093 },
            { min: 349137, max: 418961, rate: 0.103 },
            { min: 418961, max: 698271, rate: 0.113 },
            { min: 698271, max: 1000000, rate: 0.123 },
            { min: 1000000, max: Infinity, rate: 0.133 }
        ]},
        "CO": { name: "Colorado", type: "flat", rate: 0.044 },
        "CT": { name: "Connecticut", type: "bracket", brackets: [
            { min: 0, max: 10000, rate: 0.03 },
            { min: 10000, max: 50000, rate: 0.05 },
            { min: 50000, max: 100000, rate: 0.055 },
            { min: 100000, max: 200000, rate: 0.06 },
            { min: 200000, max: 250000, rate: 0.065 },
            { min: 250000, max: 500000, rate: 0.069 },
            { min: 500000, max: Infinity, rate: 0.0699 }
        ]},
        "DE": { name: "Delaware", type: "bracket", brackets: [
            { min: 0, max: 2000, rate: 0.0 },
            { min: 2000, max: 5000, rate: 0.022 },
            { min: 5000, max: 10000, rate: 0.039 },
            { min: 10000, max: 20000, rate: 0.048 },
            { min: 20000, max: 25000, rate: 0.052 },
            { min: 25000, max: 60000, rate: 0.0555 },
            { min: 60000, max: Infinity, rate: 0.066 }
        ]},
        "FL": { name: "Florida", type: "none" },
        "GA": { name: "Georgia", type: "flat", rate: 0.0549 },
        "HI": { name: "Hawaii", type: "bracket", brackets: [
            { min: 0, max: 2400, rate: 0.014 },
            { min: 2400, max: 4800, rate: 0.032 },
            { min: 4800, max: 9600, rate: 0.055 },
            { min: 9600, max: 14400, rate: 0.064 },
            { min: 14400, max: 19200, rate: 0.068 },
            { min: 19200, max: 24000, rate: 0.072 },
            { min: 24000, max: 36000, rate: 0.076 },
            { min: 36000, max: 48000, rate: 0.079 },
            { min: 48000, max: 150000, rate: 0.0825 },
            { min: 150000, max: 175000, rate: 0.09 },
            { min: 175000, max: 200000, rate: 0.10 },
            { min: 200000, max: Infinity, rate: 0.11 }
        ]},
        "ID": { name: "Idaho", type: "flat", rate: 0.058 },
        "IL": { name: "Illinois", type: "flat", rate: 0.0495 },
        "IN": { name: "Indiana", type: "flat", rate: 0.0305 },
        "IA": { name: "Iowa", type: "bracket", brackets: [
            { min: 0, max: 6210, rate: 0.044 },
            { min: 6210, max: 31050, rate: 0.0482 },
            { min: 31050, max: Infinity, rate: 0.057 }
        ]},
        "KS": { name: "Kansas", type: "bracket", brackets: [
            { min: 0, max: 15000, rate: 0.031 },
            { min: 15000, max: 30000, rate: 0.0525 },
            { min: 30000, max: Infinity, rate: 0.057 }
        ]},
        "KY": { name: "Kentucky", type: "flat", rate: 0.04 },
        "LA": { name: "Louisiana", type: "bracket", brackets: [
            { min: 0, max: 12500, rate: 0.0185 },
            { min: 12500, max: 50000, rate: 0.035 },
            { min: 50000, max: Infinity, rate: 0.0425 }
        ]},
        "ME": { name: "Maine", type: "bracket", brackets: [
            { min: 0, max: 26050, rate: 0.058 },
            { min: 26050, max: 61600, rate: 0.0675 },
            { min: 61600, max: Infinity, rate: 0.0715 }
        ]},
        "MD": { name: "Maryland", type: "bracket", brackets: [
            { min: 0, max: 1000, rate: 0.02 },
            { min: 1000, max: 2000, rate: 0.03 },
            { min: 2000, max: 3000, rate: 0.04 },
            { min: 3000, max: 100000, rate: 0.0475 },
            { min: 100000, max: 125000, rate: 0.05 },
            { min: 125000, max: 150000, rate: 0.0525 },
            { min: 150000, max: 250000, rate: 0.055 },
            { min: 250000, max: Infinity, rate: 0.0575 }
        ]},
        "MA": { name: "Massachusetts", type: "flat", rate: 0.05 },
        "MI": { name: "Michigan", type: "flat", rate: 0.0425 },
        "MN": { name: "Minnesota", type: "bracket", brackets: [
            { min: 0, max: 31690, rate: 0.0535 },
            { min: 31690, max: 104090, rate: 0.068 },
            { min: 104090, max: 183340, rate: 0.0785 },
            { min: 183340, max: Infinity, rate: 0.0985 }
        ]},
        "MS": { name: "Mississippi", type: "bracket", brackets: [
            { min: 0, max: 10000, rate: 0.0 },
            { min: 10000, max: Infinity, rate: 0.047 }
        ]},
        "MO": { name: "Missouri", type: "bracket", brackets: [
            { min: 0, max: 1207, rate: 0.02 },
            { min: 1207, max: 2414, rate: 0.025 },
            { min: 2414, max: 3621, rate: 0.03 },
            { min: 3621, max: 4828, rate: 0.035 },
            { min: 4828, max: 6035, rate: 0.04 },
            { min: 6035, max: 7242, rate: 0.045 },
            { min: 7242, max: 8449, rate: 0.05 },
            { min: 8449, max: Infinity, rate: 0.048 }
        ]},
        "MT": { name: "Montana", type: "bracket", brackets: [
            { min: 0, max: 20500, rate: 0.047 },
            { min: 20500, max: Infinity, rate: 0.059 }
        ]},
        "NE": { name: "Nebraska", type: "bracket", brackets: [
            { min: 0, max: 3700, rate: 0.0246 },
            { min: 3700, max: 22170, rate: 0.0351 },
            { min: 22170, max: 35730, rate: 0.0501 },
            { min: 35730, max: Infinity, rate: 0.0584 }
        ]},
        "NV": { name: "Nevada", type: "none" },
        "NH": { name: "New Hampshire", type: "none" },
        "NJ": { name: "New Jersey", type: "bracket", brackets: [
            { min: 0, max: 20000, rate: 0.014 },
            { min: 20000, max: 35000, rate: 0.0175 },
            { min: 35000, max: 40000, rate: 0.035 },
            { min: 40000, max: 75000, rate: 0.05525 },
            { min: 75000, max: 500000, rate: 0.0637 },
            { min: 500000, max: 1000000, rate: 0.0897 },
            { min: 1000000, max: Infinity, rate: 0.1075 }
        ]},
        "NM": { name: "New Mexico", type: "bracket", brackets: [
            { min: 0, max: 5500, rate: 0.017 },
            { min: 5500, max: 11000, rate: 0.032 },
            { min: 11000, max: 16000, rate: 0.047 },
            { min: 16000, max: 210000, rate: 0.049 },
            { min: 210000, max: Infinity, rate: 0.059 }
        ]},
        "NY": { name: "New York", type: "bracket", brackets: [
            { min: 0, max: 8500, rate: 0.04 },
            { min: 8500, max: 11700, rate: 0.045 },
            { min: 11700, max: 13900, rate: 0.0525 },
            { min: 13900, max: 80650, rate: 0.0585 },
            { min: 80650, max: 215400, rate: 0.0625 },
            { min: 215400, max: 1077550, rate: 0.0685 },
            { min: 1077550, max: 5000000, rate: 0.0965 },
            { min: 5000000, max: 25000000, rate: 0.103 },
            { min: 25000000, max: Infinity, rate: 0.109 }
        ]},
        "NC": { name: "North Carolina", type: "flat", rate: 0.045 },
        "ND": { name: "North Dakota", type: "bracket", brackets: [
            { min: 0, max: 44725, rate: 0.0195 },
            { min: 44725, max: Infinity, rate: 0.025 }
        ]},
        "OH": { name: "Ohio", type: "bracket", brackets: [
            { min: 0, max: 26050, rate: 0.0 },
            { min: 26050, max: 100000, rate: 0.02745 },
            { min: 100000, max: Infinity, rate: 0.035 }
        ]},
        "OK": { name: "Oklahoma", type: "bracket", brackets: [
            { min: 0, max: 1000, rate: 0.0025 },
            { min: 1000, max: 2500, rate: 0.0075 },
            { min: 2500, max: 3750, rate: 0.0175 },
            { min: 3750, max: 4900, rate: 0.0275 },
            { min: 4900, max: 7200, rate: 0.0375 },
            { min: 7200, max: Infinity, rate: 0.0475 }
        ]},
        "OR": { name: "Oregon", type: "bracket", brackets: [
            { min: 0, max: 4300, rate: 0.0475 },
            { min: 4300, max: 10750, rate: 0.0675 },
            { min: 10750, max: 125000, rate: 0.0875 },
            { min: 125000, max: Infinity, rate: 0.099 }
        ]},
        "PA": { name: "Pennsylvania", type: "flat", rate: 0.0307 },
        "RI": { name: "Rhode Island", type: "bracket", brackets: [
            { min: 0, max: 77450, rate: 0.0375 },
            { min: 77450, max: 176050, rate: 0.0475 },
            { min: 176050, max: Infinity, rate: 0.0599 }
        ]},
        "SC": { name: "South Carolina", type: "bracket", brackets: [
            { min: 0, max: 3460, rate: 0.0 },
            { min: 3460, max: 17330, rate: 0.03 },
            { min: 17330, max: Infinity, rate: 0.064 }
        ]},
        "SD": { name: "South Dakota", type: "none" },
        "TN": { name: "Tennessee", type: "none" },
        "TX": { name: "Texas", type: "none" },
        "UT": { name: "Utah", type: "flat", rate: 0.0465 },
        "VT": { name: "Vermont", type: "bracket", brackets: [
            { min: 0, max: 45400, rate: 0.0335 },
            { min: 45400, max: 110050, rate: 0.066 },
            { min: 110050, max: 229550, rate: 0.076 },
            { min: 229550, max: Infinity, rate: 0.0875 }
        ]},
        "VA": { name: "Virginia", type: "bracket", brackets: [
            { min: 0, max: 3000, rate: 0.02 },
            { min: 3000, max: 5000, rate: 0.03 },
            { min: 5000, max: 17000, rate: 0.05 },
            { min: 17000, max: Infinity, rate: 0.0575 }
        ]},
        "WA": { name: "Washington", type: "none" },
        "WV": { name: "West Virginia", type: "bracket", brackets: [
            { min: 0, max: 10000, rate: 0.0236 },
            { min: 10000, max: 25000, rate: 0.0315 },
            { min: 25000, max: 40000, rate: 0.0354 },
            { min: 40000, max: 60000, rate: 0.0472 },
            { min: 60000, max: Infinity, rate: 0.0512 }
        ]},
        "WI": { name: "Wisconsin", type: "bracket", brackets: [
            { min: 0, max: 14320, rate: 0.035 },
            { min: 14320, max: 28640, rate: 0.044 },
            { min: 28640, max: 315310, rate: 0.053 },
            { min: 315310, max: Infinity, rate: 0.0765 }
        ]},
        "WY": { name: "Wyoming", type: "none" },
        "DC": { name: "District of Columbia", type: "bracket", brackets: [
            { min: 0, max: 10000, rate: 0.04 },
            { min: 10000, max: 40000, rate: 0.06 },
            { min: 40000, max: 60000, rate: 0.065 },
            { min: 60000, max: 250000, rate: 0.085 },
            { min: 250000, max: 500000, rate: 0.0925 },
            { min: 500000, max: 1000000, rate: 0.0975 },
            { min: 1000000, max: Infinity, rate: 0.1075 }
        ]}
    }
};
