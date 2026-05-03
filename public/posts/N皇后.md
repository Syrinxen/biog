N 皇后问题是一个经典的**组合优化**与**回溯算法**练习题。其核心挑战在于：如何在 $N \times N$ 的棋盘上放置 $N$ 个皇后，使得它们互不攻击。

### 攻击规则

根据国际象棋规则，皇后可以攻击同一**行**、同一**列**、以及两条**对角线**上的任何单位。

## 核心算法思路：回溯法

解决该问题的最有效策略是按**行**进行递归尝试。

1. **逐行放置**：从第一行开始，尝试在每一列放置一个皇后。
    
2. **冲突检查**：在放置之前，检查当前位置是否被之前的皇后锁定（列、主对角线、副对角线）。
    
3. **递归与回溯**：
    
    - 如果当前行找到了合法位置，继续进入下一行。
        
    - 如果某一行所有列都无法放置，则返回上一行，撤销操作（回溯），尝试下一个可能的位置。
##  数学建模：如何高效判断冲突？

在 $N \times N$ 的矩阵中，判断列冲突很简单，但判断对角线冲突需要巧妙的数学转换：

### 1. 主对角线 (Main Diagonal)

沿左上到右下的方向，你会发现同一条线上所有坐标的 **$row - col$** 是一个常数。

- 为了防止出现负数下标，我们使用公式：`index = row - col + n - 1`。
    
- 范围：$0$ 到 $2n - 2$。
    
### 2. 副对角线 (Anti-Diagonal)

沿右上到左下的方向，同一条线上所有坐标的 **$row + col$** 是一个常数。

- 使用公式：`index = row + col`。
    
- 范围：$0$ 到 $2n - 2$。

## 代码实现

以下是基于回溯法的高效实现，使用 `vector<bool>` 优化冲突查询时间复杂度至 $O(1)$。

```C++
#include <bits/stdc++.h>
using namespace std;
using ll = long long;
ll n;
vector<string> board;
vector<bool> col, mainDiag, subDiag;
vector<vector<string>> ans;

void backtrack(ll row) {
    // 终止条件：所有行都已成功放置皇后
    if (row == n) {
        ans.push_back(board);
        return;
    }

    for (ll cl = 0; cl < n; ++cl) {
        // 计算对角线索引
        ll md = row - cl + n - 1;
        ll sd = cl + row;

        // 冲突检查：列或对角线已被占用则跳过
        if (col[cl] || mainDiag[md] || subDiag[sd]) continue;

        // 做选择 (Make Choice)
        board[row][cl] = 'Q';
        col[cl] = mainDiag[md] = subDiag[sd] = true;

        // 递归进入下一行
        backtrack(row + 1);

        // 撤销选择 (Backtrack)
        board[row][cl] = '.';
        col[cl] = mainDiag[md] = subDiag[sd] = false;
    }
}

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    if (!(cin >> n)) return 0;

    // 初始化容器
    board.resize(n, string(n, '.'));
    col.resize(n, false);
    mainDiag.resize(2 * n - 1, false);
    subDiag.resize(2 * n - 1, false);

    backtrack(0);

    // 输出结果
    for (const auto& res_board : ans) {
        for (const auto& row_str : res_board) {
            cout << row_str << '\n';
        }
        cout << '\n';
    }
    return 0;
}
```
## 复杂度分析

| **维度**    | **复杂度** | **说明**                |
| --------- | ------- | --------------------- |
| **时间复杂度** | $O(N!)$ | 每一行可选的列数随层数递减。        |
| **空间复杂度** | $O(N)$  | 主要消耗在递归栈和存储冲突状态的布尔数组。 |

## 扩展

- **对称性优化**：N 皇后问题的解通常是对称的。在 $N$ 较大时，可以只计算第一行前一半的列，然后通过镜像翻转得到剩余解。
    
- **位运算**：如果你追求极致性能，可以使用位运算（Bitmask）来替代布尔数组，进一步压榨 CPU 性能。