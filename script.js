function analyzeCode() {
    let code = document.getElementById('inputCode').value;
    let score = 0;
    let totalCriteria = 4; // Number of criteria we are checking

    // Check for consistent formatting (e.g., all lines start with the same indentation level)
    if (checkFormattingConsistency(code)) {
        score += 1;
    }

    // Check for generic variable names
    if (checkGenericVariableNames(code)) {
        score += 1;
    }

    // Check for lack of comments
    if (checkLackOfComments(code)) {
        score += 1;
    }

    // Check for repetitive patterns
    if (checkRepetitivePatterns(code)) {
        score += 1;
    }

    // Calculate percentage
    let percentage = (score / totalCriteria) * 100;
    document.getElementById('result').innerText = `AI-generated likelihood: ${percentage.toFixed(2)}%`;
}

function checkFormattingConsistency(code) {
    let lines = code.split('\n').map(line => line.trim());
    let indentations = lines.map(line => line.match(/^\s*/)[0].length);
    let uniqueIndentations = [...new Set(indentations)];
    return uniqueIndentations.length === 1;
}

function checkGenericVariableNames(code) {
    let genericNames = ['data', 'result', 'output', 'input'];
    let regex = new RegExp(`\\b(${genericNames.join('|')})\\b`, 'g');
    return regex.test(code);
}

function checkLackOfComments(code) {
    let commentRegex = /\/\/|\/\*|\*/;
    return !commentRegex.test(code);
}

function checkRepetitivePatterns(code) {
    let lines = code.split('\n').map(line => line.trim());
    let uniqueLines = [...new Set(lines)];
    return uniqueLines.length / lines.length < 0.8; // More than 20% repetition
}
