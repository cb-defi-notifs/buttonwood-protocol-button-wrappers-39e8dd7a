pragma solidity 0.7.6;

import "./_external/SafeMath.sol";
import "./_external/Ownable.sol";
import "./_external/ERC20Detailed.sol";
import "./_external/IERC20.sol";
import "./_external/TransferHelper.sol";
import "./interfaces/IOracle.sol";

import "./lib/SafeMathInt.sol";

/**
 * @title uFragments ERC20 token
 * @dev This is part of an implementation of the uFragments Ideal Money protocol.
 *      uFragments is a normal ERC20 token, but its supply can be adjusted by splitting and
 *      combining tokens proportionally across all wallets.
 *
 *      uFragment balances are internally represented with a hidden denomination, 'gons'.
 *      We support splitting the currency in expansion and combining the currency on contraction by
 *      changing the exchange rate between the hidden 'gons' and the public 'fragments'.
 */
contract UFragments is ERC20Detailed, Ownable {
    // PLEASE READ BEFORE CHANGING ANY ACCOUNTING OR MATH
    // Anytime there is division, there is a risk of numerical instability from rounding errors. In
    // order to minimize this risk, we adhere to the following guidelines:
    // 1) The conversion rate adopted is the number of gons that equals 1 fragment.
    //    The inverse rate must not be used--totalCollateral is always the numerator and _totalSupply
    //    is always the denominator. (i.e. If you want to convert gons to fragments instead of
    //    multiplying by the inverse rate, you should divide by the normal rate)
    // 2) Gon balances converted into Fragments are always rounded down (truncated).
    //
    // We make the following guarantees:
    // - If address 'A' transfers x Fragments to address 'B'. A's resulting external balance will
    //   be decreased by precisely x Fragments, and B's external balance will be precisely
    //   increased by x Fragments.
    //
    // We do not guarantee that the sum of all balances equals the result of calling totalSupply().
    // This is because, for any conversion function 'f()' that has non-zero rounding error,
    // f(x0) + f(x1) + ... + f(xn) is not always equal to f(x0 + x1 + ... xn).
    using SafeMath for uint256;
    using SafeMathInt for int256;

    event LogRebase(uint256 totalSupply);
    event LogMarketOracleUpdated(address marketOracle);

    modifier validRecipient(address to) {
        require(to != address(0x0));
        require(to != address(this));
        _;
    }

    uint256 private constant DECIMALS = 18;
    uint256 private constant MAX_UINT256 = type(uint256).max;
    uint256 private constant EXCHANGE_RATE_DECIMALS = 8;

    // MAX_SUPPLY = maximum integer < (sqrt(4*totalCollateral + 1) - 1) / 2
    uint256 private constant MAX_SUPPLY = type(uint128).max; // (2^128) - 1

    uint256 public override totalSupply;
    uint256 public totalCollateral;
    // exchange rate of the collateral in USD, as a 8 decimal fixed point number
    uint256 public exchangeRate;

    IERC20 public collateralToken;
    uint256 public collateralTokenDecimals;
    // Market oracle provides the token/USD exchange rate as an 8 decimal fixed point number.
    // (eg) An oracle value of 1.5e8 it would mean 1 unit of collateral is trading for $1.50.
    IOracle public marketOracle;

    mapping(address => uint256) private _collateralBalances;

    // This is denominated in Fragments, because the gons-fragments conversion might change before
    // it's fully paid.
    mapping(address => mapping(address => uint256)) private _allowedFragments;

    // EIP-2612: permit – 712-signed approvals
    // https://eips.ethereum.org/EIPS/eip-2612
    string public constant EIP712_REVISION = "1";
    bytes32 public constant EIP712_DOMAIN =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );

    // EIP-2612: keeps track of number of permits per address
    mapping(address => uint256) private _nonces;

    /**
     * @notice Sets the reference to the market oracle.
     * @param _marketOracle The address of the market oracle contract.
     */
    function setMarketOracle(IOracle _marketOracle) external onlyOwner {
        marketOracle = _marketOracle;
        emit LogMarketOracleUpdated(address(_marketOracle));
    }

    /**
     * @dev Notifies Fragments contract about a new rebase cycle.
     * @return The total number of fragments after the supply adjustment.
     */
    function rebase() public returns (uint256) {
        uint256 _exchangeRate;
        bool rateValid;
        (_exchangeRate, rateValid) = marketOracle.getData();
        require(rateValid, "Invalid rate");

        exchangeRate = _exchangeRate;

        // TODO: normalize to our decimal points system, or do that somewhere else
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        // TODO: maybe check if collateral balance changed since last rebase i.e. without mint/burn
        // and mint new tokens accordingly so we maintain invariant
        uint256 newSupply = _collateralAmountToFragmentAmount(collateralBalance);

        if (newSupply > MAX_SUPPLY) {
            newSupply = MAX_SUPPLY;
        }

        totalSupply = newSupply;
        totalCollateral = collateralBalance;

        // From this point forward, exchangeRate is taken as the source of truth.
        // We recalculate a new _totalSupply to be in agreement with the exchangeRate
        // conversion rate.
        // This means our applied newSupply can deviate from the requested newSupply,
        // but this deviation is guaranteed to be < (_totalSupply^2)/(totalCollateral - _totalSupply).
        //
        // In the case of _totalSupply <= MAX_UINT128 (our current supply cap), this
        // deviation is guaranteed to be < 1, so we can omit this step. If the supply cap is
        // ever increased, it must be re-included.
        // _totalSupply = totalCollateral.div(exchangeRate)

        emit LogRebase(newSupply);
        return newSupply;
    }

    function initialize(
        address _owner,
        IERC20 _collateralToken,
        uint256 _collateralTokenDecimals
    ) public initializer {
        require(
            _collateralTokenDecimals <= DECIMALS,
            "Invalid collateral token: too many decimals"
        );

        ERC20Detailed.initialize("Ampleforth", "AMPL", uint8(DECIMALS));
        Ownable.initialize(_owner);

        totalCollateral = 0;
        totalSupply = 0;
        // start with exchange rate of 1:1 to avoid div/0
        exchangeRate = 10**EXCHANGE_RATE_DECIMALS;
        collateralToken = _collateralToken;
        collateralTokenDecimals = _collateralTokenDecimals;

        emit Transfer(address(0x0), _owner, 0);
    }

    /**
     * @param who The address to query.
     * @return The balance of the specified address.
     */
    function balanceOf(address who) external view override returns (uint256) {
        return _collateralBalances[who].mul(exchangeRate).div(10**EXCHANGE_RATE_DECIMALS);
    }

    /**
     * @param who The address to query.
     * @return The gon balance of the specified address.
     */
    function scaledBalanceOf(address who) external view returns (uint256) {
        return _collateralBalances[who];
    }

    /**
     * @return the total number of gons.
     */
    function scaledTotalSupply() external view returns (uint256) {
        return totalCollateral;
    }

    /**
     * @return The number of successful permits by the specified address.
     */
    function nonces(address who) public view returns (uint256) {
        return _nonces[who];
    }

    /**
     * @return The computed DOMAIN_SEPARATOR to be used off-chain services
     *         which implement EIP-712.
     *         https://eips.ethereum.org/EIPS/eip-2612
     */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        uint256 chainId;
        assembly {
            chainId := chainid()
        }
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN,
                    keccak256(bytes(name())),
                    keccak256(bytes(EIP712_REVISION)),
                    chainId,
                    address(this)
                )
            );
    }

    /**
     * @dev Transfer tokens to a specified address.
     * @param to The address to transfer to.
     * @param value The amount to be transferred.
     * @return True on success, false otherwise.
     */
    function transfer(address to, uint256 value)
        external
        override
        validRecipient(to)
        returns (bool)
    {
        uint256 collateralValue = value.mul(10**EXCHANGE_RATE_DECIMALS).div(exchangeRate);

        _collateralBalances[msg.sender] = _collateralBalances[msg.sender].sub(collateralValue);
        _collateralBalances[to] = _collateralBalances[to].add(collateralValue);

        emit Transfer(msg.sender, to, value);
        return true;
    }

    /**
     * @dev Transfer all of the sender's wallet balance to a specified address.
     * @param to The address to transfer to.
     * @return True on success, false otherwise.
     */
    function transferAll(address to) external validRecipient(to) returns (bool) {
        uint256 collateralValue = _collateralBalances[msg.sender];
        uint256 value = collateralValue.mul(exchangeRate).div(10**EXCHANGE_RATE_DECIMALS);

        delete _collateralBalances[msg.sender];
        _collateralBalances[to] = _collateralBalances[to].add(collateralValue);

        emit Transfer(msg.sender, to, value);
        return true;
    }

    /**
     * @dev Function to check the amount of tokens that an owner has allowed to a spender.
     * @param _owner The address which owns the funds.
     * @param spender The address which will spend the funds.
     * @return The number of tokens still available for the spender.
     */
    function allowance(address _owner, address spender) external view override returns (uint256) {
        return _allowedFragments[_owner][spender];
    }

    /**
     * @dev Transfer tokens from one address to another.
     * @param from The address you want to send tokens from.
     * @param to The address you want to transfer to.
     * @param value The amount of tokens to be transferred.
     */
    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external override validRecipient(to) returns (bool) {
        _allowedFragments[from][msg.sender] = _allowedFragments[from][msg.sender].sub(value);

        uint256 collateralValue = value.mul(10**EXCHANGE_RATE_DECIMALS).div(exchangeRate);
        _collateralBalances[from] = _collateralBalances[from].sub(collateralValue);
        _collateralBalances[to] = _collateralBalances[to].add(collateralValue);

        emit Transfer(from, to, value);
        return true;
    }

    /**
     * @dev Transfer all balance tokens from one address to another.
     * @param from The address you want to send tokens from.
     * @param to The address you want to transfer to.
     */
    function transferAllFrom(address from, address to) external validRecipient(to) returns (bool) {
        uint256 collateralValue = _collateralBalances[from];
        uint256 value = collateralValue.mul(exchangeRate).div(10**EXCHANGE_RATE_DECIMALS);

        _allowedFragments[from][msg.sender] = _allowedFragments[from][msg.sender].sub(value);

        delete _collateralBalances[from];
        _collateralBalances[to] = _collateralBalances[to].add(collateralValue);

        emit Transfer(from, to, value);
        return true;
    }

    /**
     * @dev Approve the passed address to spend the specified amount of tokens on behalf of
     * msg.sender. This method is included for ERC20 compatibility.
     * increaseAllowance and decreaseAllowance should be used instead.
     * Changing an allowance with this method brings the risk that someone may transfer both
     * the old and the new allowance - if they are both greater than zero - if a transfer
     * transaction is mined before the later approve() call is mined.
     *
     * @param spender The address which will spend the funds.
     * @param value The amount of tokens to be spent.
     */
    function approve(address spender, uint256 value) external override returns (bool) {
        _allowedFragments[msg.sender][spender] = value;

        emit Approval(msg.sender, spender, value);
        return true;
    }

    /**
     * @dev Increase the amount of tokens that an owner has allowed to a spender.
     * This method should be used instead of approve() to avoid the double approval vulnerability
     * described above.
     * @param spender The address which will spend the funds.
     * @param addedValue The amount of tokens to increase the allowance by.
     */
    function increaseAllowance(address spender, uint256 addedValue) public returns (bool) {
        _allowedFragments[msg.sender][spender] = _allowedFragments[msg.sender][spender].add(
            addedValue
        );

        emit Approval(msg.sender, spender, _allowedFragments[msg.sender][spender]);
        return true;
    }

    /**
     * @dev Decrease the amount of tokens that an owner has allowed to a spender.
     *
     * @param spender The address which will spend the funds.
     * @param subtractedValue The amount of tokens to decrease the allowance by.
     */
    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool) {
        uint256 oldValue = _allowedFragments[msg.sender][spender];
        _allowedFragments[msg.sender][spender] = (subtractedValue >= oldValue)
            ? 0
            : oldValue.sub(subtractedValue);

        emit Approval(msg.sender, spender, _allowedFragments[msg.sender][spender]);
        return true;
    }

    /**
     * @dev Allows for approvals to be made via secp256k1 signatures.
     * @param owner The owner of the funds
     * @param spender The spender
     * @param value The amount
     * @param deadline The deadline timestamp, type(uint256).max for max deadline
     * @param v Signature param
     * @param s Signature param
     * @param r Signature param
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        require(block.timestamp <= deadline);

        uint256 ownerNonce = _nonces[owner];
        bytes32 permitDataDigest =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, ownerNonce, deadline));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), permitDataDigest));

        require(owner == ecrecover(digest, v, r, s));

        _nonces[owner] = ownerNonce.add(1);

        _allowedFragments[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /** @dev Wraps `collateralAmount` collateral tokens and creates
     * appropriate number of wrapper tokens, assigning them to `to`, increasing
     * the total supply.
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - `to` cannot be the address of this contract.
     * - `collateralAmount` collateral tokens must be pre-approved to this contract
     */
    function mint(address to, uint256 collateralAmount) external validRecipient(to) {
        // rebase();
        TransferHelper.safeTransferFrom(
            address(collateralToken),
            msg.sender,
            address(this),
            collateralAmount
        );

        uint256 fragmentAmount = _collateralAmountToFragmentAmount(collateralAmount);
        totalCollateral = totalCollateral.add(collateralAmount);
        _collateralBalances[to] = _collateralBalances[to].add(collateralAmount);
        totalSupply = totalSupply.add(fragmentAmount);
        emit Transfer(address(0), to, fragmentAmount);
    }

    /** @dev Wraps `collateralAmount` collateral tokens and creates
     * appropriate number of wrapper tokens, assigning them to `to`, increasing
     * the total supply.
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - `to` cannot be the address of this contract.
     * - `collateralAmount` collateral tokens must be pre-approved to this contract
     */
    function burn(address from, uint256 fragmentAmount) external validRecipient(from) {
        uint256 collateralAmount = fragmentAmount.mul(10**EXCHANGE_RATE_DECIMALS).div(exchangeRate);

        uint256 fragmentAmount = _collateralAmountToFragmentAmount(collateralAmount);
        totalCollateral = totalCollateral.sub(collateralAmount);
        _collateralBalances[from] = _collateralBalances[from].sub(collateralAmount);
        totalSupply = totalSupply.sub(fragmentAmount);
        // rebase();
        emit Transfer(from, address(0), fragmentAmount);
    }

    /**
     * @dev Transforms an amount of collateral tokens to an amount of fragments
     * This takes into account both the decimal precision and the exchange rate
     */
    function _collateralAmountToFragmentAmount(uint256 collateralAmount)
        private
        view
        returns (uint256 fragmentAmount)
    {
        uint256 precisionDifference = DECIMALS.sub(collateralTokenDecimals);
        // A note on overflow concerns with unsafe exponentiation:
        // The `precisionDifference` value is limited to 17 (i.e. underlying token has 1 decimal place of precision)
        // So 10^17 is the maximum value generated by the exponentiation, which does not overflow.
        return
            collateralAmount.mul(exchangeRate).div(10**EXCHANGE_RATE_DECIMALS).mul(
                10**precisionDifference
            );
    }
}
