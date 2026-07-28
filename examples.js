/**
 * AI Code Detector - Examples Gallery
 *
 * A curated set of code samples that illustrate the kinds of "tells" the
 * detector looks for. Most samples are CURATED (distilled from common LLM
 * idioms) so each one cleanly demonstrates one or two signals. A few are
 * VERBATIM transcripts captured from popular LLMs to give a real-world feel.
 *
 * Each entry:
 *   id            unique slug
 *   language      "javascript" | "typescript" | "python" | "java"
 *   sourceLabel   "ChatGPT" | "Claude" | "Copilot" | "Gemini" | "Curated"
 *   provenance    "verbatim" | "curated"  (tells the user how it was sourced)
 *   title, blurb  display strings
 *   code          the code shown in the gallery and loaded into the analyzer
 *   annotations   [{ lineRange:[start,end], signal, why, scored? }]
 *   expectedSignals  signal ids the detector should flag (used as a self-test)
 *
 * An annotation explains a tell a reader should learn to see, which is a wider
 * set than the tells this detector scores. Where the two diverge the annotation
 * carries `scored: false` and says why in its own text -- usually because the
 * signal is gated on a snippet length this sample doesn't reach, or because it
 * matches literal text where the sample only repeats a shape. Every annotation
 * without that flag is checked against the live detector by test/, so the
 * teaching material cannot quietly drift away from the code.
 */
const AI_CODE_EXAMPLES = [
  {
    id: "py-overcommented-fizzbuzz",
    language: "python",
    sourceLabel: "ChatGPT",
    provenance: "verbatim",
    title: "Over-commented FizzBuzz",
    blurb: "Trivial logic, every line narrated. Classic LLM tutorial style.",
    code:
`# Here's a simple Python program that prints the FizzBuzz sequence.
# It iterates from 1 to 100 and applies the FizzBuzz rules.

def fizzbuzz(n):
    # Loop from 1 to n inclusive
    for i in range(1, n + 1):
        # Check if i is divisible by both 3 and 5
        if i % 3 == 0 and i % 5 == 0:
            # Print "FizzBuzz" if so
            print("FizzBuzz")
        # Check if i is divisible by 3
        elif i % 3 == 0:
            # Print "Fizz" if so
            print("Fizz")
        # Check if i is divisible by 5
        elif i % 5 == 0:
            # Print "Buzz" if so
            print("Buzz")
        else:
            # Otherwise print the number itself
            print(i)

# Call the function with 100
fizzbuzz(100)`,
    annotations: [
      { lineRange: [1, 2], signal: "preamble_strings",            why: "Conversational lead-in (\"Here's a simple ...\") that LLMs prepend when asked for code." },
      { lineRange: [5, 21], signal: "over_commenting_trivial_ops", why: "Every line is preceded by a comment that restates exactly what the next line does." },
      { lineRange: [3, 3], signal: "generic_names", scored: false, why: "Function takes a single parameter named n with no domain meaning. Not scored: the signal matches a fixed list of placeholder words, and bare single letters are not on it." }
    ],
    expectedSignals: ["preamble_strings", "over_commenting_trivial_ops"]
  },

  {
    id: "py-exhaustive-try-except",
    language: "python",
    sourceLabel: "Claude",
    provenance: "curated",
    title: "Defensive Try/Except Everywhere",
    blurb: "Wraps every operation in try/except and guards every variable against None. The 'safe by default' overcorrection.",
    code:
`def load_user_profile(user_id, config):
    if user_id is None:
        return None
    if config is None:
        return None
    if not isinstance(user_id, str):
        return None

    try:
        try:
            user = db.fetch_user(user_id)
        except Exception as e:
            print(f"Error fetching user: {e}")
            return None

        if user is None:
            return None

        try:
            profile = user.get("profile")
        except Exception as e:
            print(f"Error reading profile: {e}")
            return None

        if profile is None:
            return None

        return profile
    except Exception as e:
        print(f"Unexpected error: {e}")
        return None`,
    annotations: [
      { lineRange: [2, 7],   signal: "defensive_null_checks",  why: "Guards every parameter against None at the top of the function, even though the caller's contract usually rules them out." },
      { lineRange: [9, 31],  signal: "excessive_try_except",   why: "Nested try blocks, each catching the broad Exception base class with a generic print + return None." },
      { lineRange: [16, 26], signal: "defensive_null_checks",  why: "Re-checks for None after every step, including for values that can never be None." }
    ],
    expectedSignals: ["excessive_try_except", "defensive_null_checks"]
  },

  {
    id: "py-perfect-pep8-typehints",
    language: "python",
    sourceLabel: "ChatGPT",
    provenance: "curated",
    title: "Perfect PEP-8 with Type Hints on Trivial Helpers",
    blurb: "Every parameter and return is annotated, every helper has a docstring, indentation is identical to the byte. Real codebases drift; LLMs don't.",
    code:
`from typing import List, Optional


def add(a: int, b: int) -> int:
    """Return the sum of two integers."""
    return a + b


def subtract(a: int, b: int) -> int:
    """Return the difference of two integers."""
    return a - b


def multiply(a: int, b: int) -> int:
    """Return the product of two integers."""
    return a * b


def divide(a: int, b: int) -> Optional[float]:
    """Return the quotient of two integers, or None if dividing by zero."""
    if b == 0:
        return None
    return a / b


def sum_list(values: List[int]) -> int:
    """Return the sum of a list of integers."""
    total: int = 0
    for value in values:
        total += value
    return total`,
    annotations: [
      { lineRange: [4, 31], signal: "formatting_too_clean",  why: "Indentation is identical on every line, two blank lines between every top-level def, no trailing whitespace anywhere." },
      { lineRange: [4, 22], signal: "symmetric_helper_names", why: "Symmetric one-liner helpers (add/subtract/multiply/divide) - a textbook signature pattern, rare in real codebases." },
      { lineRange: [1, 31], signal: "no_todo_fixme", scored: false, why: "Not a single TODO/FIXME/XXX anywhere, where production code almost always carries one. Not scored: the signal needs 25 non-empty lines before it will fire and this sample has 21, so the tell is visible to a reader but below the gate." }
    ],
    expectedSignals: ["formatting_too_clean", "symmetric_helper_names", "generic_names"]
  },

  {
    id: "js-jsdoc-on-everything",
    language: "javascript",
    sourceLabel: "Copilot",
    provenance: "curated",
    title: "JSDoc on Every Function (Including One-Liners)",
    blurb: "JSDoc blocks the size of the function they document. A common Copilot tell when autocomplete picks up the comment-first style.",
    code:
`/**
 * Returns the sum of two numbers.
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The sum of a and b.
 */
function add(a, b) {
    return a + b;
}

/**
 * Returns the product of two numbers.
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The product of a and b.
 */
function multiply(a, b) {
    return a * b;
}

/**
 * Returns true if the value is truthy.
 * @param {*} value - The value to check.
 * @returns {boolean} Whether the value is truthy.
 */
function isTruthy(value) {
    return Boolean(value);
}

/**
 * Returns the input as-is.
 * @param {*} data - The input data.
 * @returns {*} The same data.
 */
function identity(data) {
    return data;
}`,
    annotations: [
      { lineRange: [1, 6],   signal: "jsdoc_on_everything", why: "A six-line JSDoc block precedes a one-line function. The doc is bigger than the body." },
      { lineRange: [11, 16], signal: "jsdoc_on_everything", why: "Symmetric JSDoc shape repeated for every helper - same field order, same phrasing." },
      { lineRange: [35, 35], signal: "generic_names",       why: "Parameter named 'data' with no domain meaning." }
    ],
    expectedSignals: ["jsdoc_on_everything", "generic_names"]
  },

  {
    id: "js-symmetric-helpers",
    language: "javascript",
    sourceLabel: "ChatGPT",
    provenance: "curated",
    title: "Symmetric Helper Names with Redundant Plumbing",
    blurb: "process / handle / format / validate cluster, plus 'let result = ...; return result;' everywhere. The textbook small-helpers shape.",
    code:
`function processData(data) {
    let result = data.map(item => item);
    return result;
}

function handleData(data) {
    let result = processData(data);
    return result;
}

function formatData(data) {
    let result = handleData(data).join(", ");
    return result;
}

function validateData(data) {
    let result = Array.isArray(data);
    return result;
}

function parseData(data) {
    let result = JSON.parse(data);
    return result;
}`,
    annotations: [
      { lineRange: [1, 23], signal: "symmetric_helper_names", why: "Five functions all named <verb>Data; verbs come from the canonical LLM verb pool (process/handle/format/validate/parse)." },
      { lineRange: [2, 22], signal: "repetitive_lines",        why: "Same `let result = ...; return result;` shape repeated five times - shouldn't survive a code review." },
      { lineRange: [1, 23], signal: "generic_names",           why: "Every parameter is `data` and every intermediate is `result`." }
    ],
    expectedSignals: ["symmetric_helper_names", "repetitive_lines", "generic_names"]
  },

  {
    id: "java-defensive-getters",
    language: "java",
    sourceLabel: "Claude",
    provenance: "curated",
    title: "Javadoc-on-Getters with Defensive Null Checks",
    blurb: "Every getter has a Javadoc and a null guard, even though the field is set in the constructor and never reassigned.",
    code:
`/**
 * Represents a user in the system.
 */
public class User {
    private String name;
    private String email;
    private Integer age;

    /**
     * Constructs a new User.
     * @param name the user's name
     * @param email the user's email
     * @param age the user's age
     */
    public User(String name, String email, Integer age) {
        if (name == null) {
            throw new IllegalArgumentException("name cannot be null");
        }
        if (email == null) {
            throw new IllegalArgumentException("email cannot be null");
        }
        if (age == null) {
            throw new IllegalArgumentException("age cannot be null");
        }
        this.name = name;
        this.email = email;
        this.age = age;
    }

    /**
     * Returns the user's name.
     * @return the name
     */
    public String getName() {
        if (name == null) {
            return "";
        }
        return name;
    }

    /**
     * Returns the user's email.
     * @return the email
     */
    public String getEmail() {
        if (email == null) {
            return "";
        }
        return email;
    }
}`,
    annotations: [
      { lineRange: [16, 24], signal: "defensive_null_checks", why: "Three back-to-back null guards in the constructor - then re-guarded again in every getter even though the constructor already enforced non-null." },
      { lineRange: [35, 38], signal: "defensive_null_checks", why: "Getter checks for null on a field that the constructor guaranteed is non-null." },
      { lineRange: [1, 51],  signal: "jsdoc_on_everything",   why: "Javadoc block on the class, the constructor, and every getter - all repeating information that the signature already conveys." }
    ],
    expectedSignals: ["defensive_null_checks", "jsdoc_on_everything"]
  },

  {
    id: "ts-overstructured-validator",
    language: "typescript",
    sourceLabel: "Gemini",
    provenance: "curated",
    title: "Over-structured Validator with Exhaustive Switch",
    blurb: "Every branch checks every field with the same pattern; the switch has a default that simply re-throws.",
    code:
`type Event =
    | { type: "login"; userId: string }
    | { type: "logout"; userId: string }
    | { type: "purchase"; userId: string; amount: number }
    | { type: "refund"; userId: string; amount: number };

function validateEvent(event: Event): boolean {
    if (event === null) {
        return false;
    }
    if (event === undefined) {
        return false;
    }
    if (event.type === null) {
        return false;
    }
    if (event.type === undefined) {
        return false;
    }

    switch (event.type) {
        case "login":
            if (event.userId === null) return false;
            if (event.userId === undefined) return false;
            if (event.userId === "") return false;
            return true;
        case "logout":
            if (event.userId === null) return false;
            if (event.userId === undefined) return false;
            if (event.userId === "") return false;
            return true;
        case "purchase":
            if (event.userId === null) return false;
            if (event.userId === undefined) return false;
            if (event.amount === null) return false;
            if (event.amount === undefined) return false;
            return true;
        case "refund":
            if (event.userId === null) return false;
            if (event.userId === undefined) return false;
            if (event.amount === null) return false;
            if (event.amount === undefined) return false;
            return true;
        default:
            throw new Error("Unknown event type");
    }
}`,
    annotations: [
      { lineRange: [8, 19],  signal: "defensive_null_checks", why: "Four guard checks for null/undefined on fields whose types already exclude those values." },
      { lineRange: [21, 45], signal: "over_structured",       why: "Switch with four cases, each repeating the same null/undefined/empty pattern. The default branch throws, also a textbook LLM shape." },
      { lineRange: [22, 42], signal: "repetitive_lines",      why: "Identical guard lines copy-pasted across cases instead of being extracted into a helper." }
    ],
    expectedSignals: ["over_structured", "repetitive_lines", "defensive_null_checks"]
  },

  {
    id: "js-redundant-assignments",
    language: "javascript",
    sourceLabel: "Curated",
    provenance: "curated",
    title: "Redundant Variable Assignments",
    blurb: "Wraps trivial expressions in named intermediates so each step has a comment to point at. A frequent LLM choice when asked to 'explain step by step'.",
    code:
`function computeDiscountedTotal(items, discountRate) {
    // Get the items array
    const itemsList = items;
    // Get the discount rate
    const rate = discountRate;
    // Compute the subtotal
    let subtotal = 0;
    // Iterate through each item
    for (let i = 0; i < itemsList.length; i++) {
        // Get the current item
        const currentItem = itemsList[i];
        // Get the price of the item
        const price = currentItem.price;
        // Add the price to the subtotal
        subtotal = subtotal + price;
    }
    // Compute the discount amount
    const discountAmount = subtotal * rate;
    // Compute the total after discount
    const total = subtotal - discountAmount;
    // Return the total
    return total;
}`,
    annotations: [
      { lineRange: [3, 5],   signal: "generic_names",                 why: "Renames the parameters to local variables of the same meaning (`itemsList`, `rate`) for no reason." },
      { lineRange: [2, 22],  signal: "over_commenting_trivial_ops",   why: "Eleven comments in 22 lines, every one restating the very next statement." },
      { lineRange: [11, 15], signal: "repetitive_lines", scored: false, why: "Multiple intermediate variables (`currentItem`, `price`, `subtotal = subtotal + price`) where one expression would do. Not scored: the signal counts lines duplicated verbatim, and these repeat a shape rather than exact text." }
    ],
    expectedSignals: ["over_commenting_trivial_ops", "generic_names"]
  }
];

/* Published on `window` for the browser and on `module.exports` for Node, so
   the gallery data has exactly one definition and the test suite can check it
   (ids unique, annotation line ranges in bounds, expectedSignals actually
   firing) without a headless browser. */
if (typeof window !== 'undefined') window.AI_CODE_EXAMPLES = AI_CODE_EXAMPLES;
if (typeof module !== 'undefined' && module.exports) module.exports = AI_CODE_EXAMPLES;
